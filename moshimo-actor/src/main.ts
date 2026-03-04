import { Actor, log } from 'apify';
import { chromium, Page } from 'playwright';
import { readFileSync } from 'fs';
import iconv from 'iconv-lite';

interface TargetAd {
  value: string;
  label: string;
}

interface InputSchema {
  loginId: string;
  password: string;
  targetAds: TargetAd[];
}

interface FileResult {
  adName: string;
  promotionId: string;
  fileName: string;
  kvStoreKey: string;
  sizeBytes: number;
}

interface FailureResult {
  adName: string;
  promotionId: string;
  step: string;
  reason: string;
  retried: boolean;
}

const LOGIN_URL = 'https://secure.moshimo.com/af/merchant/login2';
const RESULT_SEARCH_URL = 'https://secure.moshimo.com/af/merchant/result/search';
const DEFAULT_TIMEOUT = 60_000;
const DOWNLOAD_TIMEOUT = 30_000;

await Actor.init();

const input = await Actor.getInput<InputSchema>();
if (!input?.loginId || !input?.password) {
  throw new Error('loginId and password are required');
}
if (!input.targetAds || input.targetAds.length === 0) {
  throw new Error('targetAds is required and must not be empty');
}

const targetAds = input.targetAds.filter(
  (ad) => ad.value && ad.value.trim().length > 0,
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

  for (const ad of targetAds) {
    const slug = slugify(ad.label);
    log.info(`=== 案件処理開始: ${ad.label} (${ad.value}) ===`);

    let success = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await downloadCsvForPromotion(page, kvStore, ad, slug);
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
            promotionId: ad.value,
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
    aspId: 'moshimo',
    aspName: 'もしもアフィリエイト',
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
    aspId: 'moshimo',
    aspName: 'もしもアフィリエイト',
    status: 'FAILED',
    files,
    failures: [
      ...failures,
      {
        adName: '__global__',
        promotionId: '',
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

async function login(page: Page, loginId: string, password: string): Promise<void> {
  log.info('ログインページへ遷移');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });

  await page.fill('input[name="account"]', loginId);
  await page.fill('input[name="password"]', password);

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => null),
    clickFirst(page, [
      'input[type="submit"][value="ログイン"]',
      'button[type="submit"]',
    ], 'ログインボタン'),
  ]);

  if (page.url().includes('login')) {
    throw new Error('ログイン後もログイン画面に留まっています');
  }
}

async function downloadCsvForPromotion(
  page: Page,
  kvStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
  ad: TargetAd,
  slug: string,
): Promise<void> {
  log.info(`成果承認ページへ遷移: ${ad.label}`);
  await page.goto(RESULT_SEARCH_URL, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
  await saveScreenshot(kvStore, page, screenshotKeys, `search-page-${slug}`);

  // プルダウンで案件を選択
  await page.selectOption('select[name="promotion_id"]', ad.value);
  log.info(`プロモーション選択: ${ad.label} (value=${ad.value})`);
  await page.waitForTimeout(500);
  await saveScreenshot(kvStore, page, screenshotKeys, `after-select-${slug}`);

  // CSVダウンロードボタンをクリック
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }),
    clickFirst(page, [
      'a.search-csv-download-button',
      'a[class*="csv-download"]',
      'a:has-text("CSV")',
    ], 'CSVダウンロードボタン'),
  ]);

  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('ダウンロードファイルのパス取得に失敗しました');
  }

  const raw = readFileSync(downloadPath);
  const content = decodeCsv(raw);
  const timestamp = Date.now();
  const kvStoreKey = `csv_moshimo_${slug}_${timestamp}`;

  await kvStore.setValue(kvStoreKey, content, { contentType: 'text/csv; charset=utf-8' });

  const suggested = download.suggestedFilename() || `moshimo_${slug}_${timestamp}.csv`;

  files.push({
    adName: ad.label,
    promotionId: ad.value,
    fileName: suggested,
    kvStoreKey,
    sizeBytes: raw.length,
  });

  log.info(`CSV保存完了: ${kvStoreKey} (${raw.length} bytes)`);
}

function decodeCsv(raw: Buffer): string {
  const asUtf8 = raw.toString('utf-8');
  if (!asUtf8.includes('\uFFFD')) {
    return asUtf8;
  }
  return iconv.decode(raw, 'Shift_JIS');
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

async function saveScreenshot(
  kvStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
  page: Page,
  screenshotKeys: string[],
  label: string,
): Promise<void> {
  const key = `screenshot_moshimo_${label}_${Date.now()}`;
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
