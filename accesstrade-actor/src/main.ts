import { Actor, log } from 'apify';
import { chromium, Page } from 'playwright';
import { readFileSync } from 'fs';
import iconv from 'iconv-lite';

interface TargetAd {
  programId: string;
  label: string;
}

interface InputSchema {
  loginId: string;
  password: string;
  targetAds: TargetAd[];
}

interface FileResult {
  adName: string;
  programId: string;
  fileName: string;
  kvStoreKey: string;
  sizeBytes: number;
}

interface FailureResult {
  adName: string;
  programId: string;
  step: string;
  reason: string;
  retried: boolean;
}

const LOGIN_URL = 'https://merchant.accesstrade.net/matv3/login.html?m=1';
const BASE_URL = 'https://merchant.accesstrade.net/matv3/program';
const DEFAULT_TIMEOUT = 60_000;
const DOWNLOAD_TIMEOUT = 30_000;

function getTodayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

await Actor.init();

const input = await Actor.getInput<InputSchema>();
if (!input?.loginId || !input?.password) {
  throw new Error('loginId and password are required');
}
if (!input.targetAds || input.targetAds.length === 0) {
  throw new Error('targetAds is required and must not be empty');
}

const targetAds = input.targetAds.filter(
  (ad) => ad.programId && ad.programId.trim().length > 0,
);

if (targetAds.length === 0) {
  throw new Error('targetAds does not contain usable entries');
}

const kvStore = await Actor.openKeyValueStore();
const files: FileResult[] = [];
const failures: FailureResult[] = [];
const screenshotKeys: string[] = [];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  acceptDownloads: true,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});
context.setDefaultTimeout(DEFAULT_TIMEOUT);
const page = await context.newPage();

try {
  await login(page, input.loginId, input.password);
  await saveScreenshot(kvStore, page, screenshotKeys, 'post-login');

  const today = getTodayString();

  for (const ad of targetAds) {
    const slug = slugify(ad.label);
    log.info(`=== 案件処理開始: ${ad.label} (${ad.programId}) ===`);

    let success = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await downloadUnapprovalCsv(page, kvStore, ad, slug, today);
        await downloadGoodsUnapprovalCsv(page, kvStore, ad, slug, today);
        success = true;
        log.info(`案件処理成功: ${ad.label}`);
        break;
      } catch (error: any) {
        const reason = error?.message || 'unknown error';
        const retried = attempt > 1;
        log.warning(`案件処理失敗(${attempt}/2): ${ad.label} - ${reason}`);
        await saveScreenshot(kvStore, page, screenshotKeys, `error-${slug}-attempt-${attempt}`);
        if (attempt === 2) {
          failures.push({
            adName: ad.label,
            programId: ad.programId,
            step: 'ad_loop',
            reason,
            retried,
          });
        }
      }
    }

    if (!success) {
      log.error(`案件処理最終失敗: ${ad.label}`);
    }
  }

  const succeededAds = files.length;
  const failedAds = failures.length;
  const status =
    succeededAds === 0 ? 'FAILED'
      : failedAds > 0 ? 'PARTIAL_SUCCESS'
      : 'SUCCESS';

  await Actor.pushData({
    aspId: 'accesstrade',
    aspName: 'アクセストレード',
    status,
    files,
    failures,
    processedAds: targetAds.length,
    succeededAds,
    failedAds,
    screenshotKeys,
    executedAt: new Date().toISOString(),
  });
} catch (error: any) {
  const reason = error?.message || 'unknown fatal error';
  log.error(`致命的エラー: ${reason}`);
  await saveScreenshot(kvStore, page, screenshotKeys, 'fatal-error');

  await Actor.pushData({
    aspId: 'accesstrade',
    aspName: 'アクセストレード',
    status: 'FAILED',
    files,
    failures: [
      ...failures,
      {
        adName: '__global__',
        programId: '',
        step: 'fatal',
        reason,
        retried: false,
      },
    ],
    processedAds: targetAds.length,
    succeededAds: files.length,
    failedAds: Math.max(1, failures.length),
    screenshotKeys,
    executedAt: new Date().toISOString(),
  });
} finally {
  await browser.close();
  await Actor.exit();
}

// ---------- Functions ----------

async function login(page: Page, loginId: string, password: string): Promise<void> {
  log.info('ログインページへ遷移');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
  await saveScreenshot(kvStore, page, screenshotKeys, 'login-page');

  // Angular formcontrolname属性でフォーム入力
  await fillFirst(page, [
    'input[formcontrolname="userName"]',
    'input[name="userName"]',
    'input[type="text"]',
  ], loginId, 'ログインID入力');

  await fillFirst(page, [
    'input[formcontrolname="password"]',
    'input[name="password"]',
    'input[type="password"]',
  ], password, 'パスワード入力');

  await saveScreenshot(kvStore, page, screenshotKeys, 'before-login-click');

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => null),
    clickFirst(page, [
      'button[type="submit"]',
      'button:has-text("ログイン")',
      'input[type="submit"]',
    ], 'ログインボタン'),
  ]);

  await page.waitForTimeout(3000);

  // ログイン後の遷移を確認
  if (page.url().includes('login')) {
    throw new Error(`ログイン失敗: ${page.url()}`);
  }
  log.info(`ログイン成功: ${page.url()}`);
}

async function downloadUnapprovalCsv(
  page: Page,
  kvStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
  ad: TargetAd,
  slug: string,
  today: string,
): Promise<void> {
  const url = `${BASE_URL}/${ad.programId}/result/unapproval/list.html?targetTo=${today}`;
  log.info(`未承認成果ページへ遷移: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
  await page.waitForTimeout(2000);
  await saveScreenshot(kvStore, page, screenshotKeys, `unapproval-page-${slug}`);

  await downloadCsvFromPage(page, kvStore, ad, slug, 'unapproval');
}

async function downloadGoodsUnapprovalCsv(
  page: Page,
  kvStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
  ad: TargetAd,
  slug: string,
  today: string,
): Promise<void> {
  const url = `${BASE_URL}/${ad.programId}/result/goods/unapproval/list.html?targetTo=${today}`;
  log.info(`商品別未承認成果ページへ遷移: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
  await page.waitForTimeout(2000);
  await saveScreenshot(kvStore, page, screenshotKeys, `goods-unapproval-page-${slug}`);

  await downloadCsvFromPage(page, kvStore, ad, slug, 'goods_unapproval');
}

async function downloadCsvFromPage(
  page: Page,
  kvStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
  ad: TargetAd,
  slug: string,
  csvType: string,
): Promise<void> {
  // 「未承認データダウンロード」ボタンをクリック
  await clickFirst(page, [
    'span.ma_btn_type1:has-text("未承認データダウンロード")',
    'button:has-text("未承認データダウンロード")',
    'a:has-text("未承認データダウンロード")',
    'span:has-text("未承認データダウンロード")',
  ], '未承認データダウンロードボタン');

  await page.waitForTimeout(1000);
  await saveScreenshot(kvStore, page, screenshotKeys, `after-dl-btn-${csvType}-${slug}`);

  // プルダウンから「CSV」を選択してダウンロード
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }),
    clickFirst(page, [
      'a.dropdown-item:has-text("CSV")',
      'a:has-text("CSV")',
      'li:has-text("CSV") a',
      'button:has-text("CSV")',
    ], 'CSVダウンロード選択'),
  ]);

  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('ダウンロードファイルのパス取得に失敗しました');
  }

  const raw = readFileSync(downloadPath);
  const content = decodeCsv(raw);
  const timestamp = Date.now();
  const kvStoreKey = `csv_at_${csvType}_${slug}_${timestamp}`;

  await kvStore.setValue(kvStoreKey, content, { contentType: 'text/csv; charset=utf-8' });

  const suggested = download.suggestedFilename() || `at_${csvType}_${slug}_${timestamp}.csv`;

  files.push({
    adName: ad.label,
    programId: ad.programId,
    fileName: suggested,
    kvStoreKey,
    sizeBytes: raw.length,
  });

  log.info(`CSV保存完了: ${kvStoreKey} (${raw.length} bytes)`);
}

// ---------- Helpers ----------

async function fillFirst(page: Page, selectors: string[], value: string, label: string): Promise<void> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 3000 });
      await loc.fill(value);
      log.info(`${label}: ${sel}`);
      return;
    } catch {
      // try next
    }
  }
  throw new Error(`${label} が見つかりません`);
}

async function clickFirst(page: Page, selectors: string[], label: string): Promise<void> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 3000 });
      await loc.click();
      log.info(`${label}: ${sel}`);
      return;
    } catch {
      // try next
    }
  }
  throw new Error(`${label} が見つかりません`);
}

function decodeCsv(raw: Buffer): string {
  const asUtf8 = raw.toString('utf-8');
  if (!asUtf8.includes('\uFFFD')) {
    return asUtf8;
  }
  return iconv.decode(raw, 'Shift_JIS');
}

async function saveScreenshot(
  kvStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
  page: Page,
  screenshotKeys: string[],
  label: string,
): Promise<void> {
  const key = `screenshot_at_${label}_${Date.now()}`;
  const image = await page.screenshot({ fullPage: true }).catch(() => null);
  if (!image) return;
  await kvStore.setValue(key, image, { contentType: 'image/png' });
  screenshotKeys.push(key);
}

function slugify(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return normalized || 'ad';
}
