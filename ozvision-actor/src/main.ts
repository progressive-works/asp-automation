import { Actor, log } from 'apify';
import { chromium, Frame, Page } from 'playwright';
import { readFileSync } from 'fs';
import iconv from 'iconv-lite';

interface InputSchema {
  aspId: string;
  loginId: string;
  password: string;
  targetAds: string[];
}

interface SiteConfig {
  baseUrl: string;
  aspName: string;
}

const SITES: Record<string, SiteConfig> = {
  ozvision: { baseUrl: 'https://ozasp.jp', aspName: 'オズビジョン' },
  daicon:   { baseUrl: 'https://daicon-link.com', aspName: 'ダイコン' },
};

interface FileResult {
  adName: string;
  fileName: string;
  kvStoreKey: string;
  sizeBytes: number;
}

interface FailureResult {
  adName: string;
  step: string;
  reason: string;
  retried: boolean;
}

const DEFAULT_TIMEOUT = 60_000;
const DOWNLOAD_TIMEOUT = 30_000;

await Actor.init();

const input = await Actor.getInput<InputSchema>();
if (!input?.aspId || !SITES[input.aspId]) {
  throw new Error(`aspId is required and must be one of: ${Object.keys(SITES).join(', ')}`);
}
if (!input?.loginId || !input?.password) {
  throw new Error('loginId and password are required');
}
if (!input.targetAds || input.targetAds.length === 0) {
  throw new Error('targetAds is required and must not be empty');
}

const site = SITES[input.aspId];
const aspId = input.aspId;
const aspName = site.aspName;
const LOGIN_URL = `${site.baseUrl}/contents.php?c=c_advertiser_login`;
const UNAPPROVED_URL = `${site.baseUrl}/search.php?type=action_log_raw&tab_type=0`;

const targetAds = Array.from(
  new Set(
    input.targetAds
      .map((ad) => ad.trim())
      .filter((ad) => ad.length > 0),
  ),
);

if (targetAds.length === 0) {
  throw new Error('targetAds does not contain usable ad names');
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

  for (const adName of targetAds) {
    const slug = slugify(adName);
    log.info(`=== 広告処理開始: ${adName} ===`);

    let success = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(UNAPPROVED_URL, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
        await saveScreenshot(kvStore, page, screenshotKeys, `unapproved-${slug}-attempt-${attempt}`);

        await selectPromotionByAdName(page, adName);
        const fileResult = await downloadCsvWithUtf8(page, kvStore, adName);
        files.push(fileResult);
        success = true;
        log.info(`広告処理成功: ${adName}`);
        break;
      } catch (error: any) {
        const reason = error?.message || 'unknown error';
        const retried = attempt > 1;
        log.warning(`広告処理失敗(${attempt}/2): ${adName} - ${reason}`);
        await saveScreenshot(kvStore, page, screenshotKeys, `error-${slug}-attempt-${attempt}`);
        if (attempt === 2) {
          failures.push({
            adName,
            step: 'ad_loop',
            reason,
            retried,
          });
        }
      }
    }

    if (!success) {
      log.error(`広告処理最終失敗: ${adName}`);
    }
  }

  const succeededAds = files.length;
  const failedAds = failures.length;
  const status =
    succeededAds === 0 ? 'FAILED'
      : failedAds > 0 ? 'PARTIAL_SUCCESS'
      : 'SUCCESS';

  await Actor.pushData({
    aspId,
    aspName,
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
    aspId,
    aspName,
    status: 'FAILED',
    files,
    failures: [
      ...failures,
      {
        adName: '__global__',
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

  await page.fill('input[name="mail"]', loginId);
  await page.fill('input[name="pass"]', password);

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => null),
    page.click('div.button-login input[type="submit"][value="ログイン"]'),
  ]);

  if (page.url().includes('c_advertiser_login')) {
    throw new Error('ログイン後もログイン画面に留まっています');
  }
}

async function selectPromotionByAdName(page: Page, adName: string): Promise<void> {
  await clickFirst(page, [
    'p.btn.btn-tb a.thickbox[href*="type=promotion"]',
    'a.thickbox[href*="type=promotion"]',
  ], '広告選択ボタン');

  const promotionFrame = await waitForFrameByUrlIncludes(page, 'type=promotion', 15_000);
  if (!promotionFrame) {
    throw new Error('広告選択モーダルのiframeを検出できません');
  }

  await fillFirstInFrame(promotionFrame, [
    'input[name="keyword"]',
    'input[name="freeword"]',
    'input[name="word"]',
    'input[type="text"]',
  ], adName, '広告フリーワード');

  await clickFirstInFrame(promotionFrame, [
    'input[type="submit"][value*="検索"]',
    'button:has-text("検索")',
    'a:has-text("検索")',
    'input[type="submit"]',
  ], '広告検索ボタン');

  await promotionFrame.waitForTimeout(1000);
  await selectAdResultInFrame(promotionFrame, adName);

  const confirmed = await tryClickFirstInFrame(promotionFrame, [
    'input[type="submit"][value*="選択"]',
    'input[type="button"][value*="選択"]',
    'input[type="submit"][value*="決定"]',
    'button:has-text("選択")',
    'button:has-text("決定")',
    'a:has-text("選択")',
    'a:has-text("決定")',
  ], '広告選択確定ボタン');

  // サイトによっては候補クリック時点で確定されるため、確定ボタンは任意扱いにする。
  if (!confirmed) {
    log.info('広告選択確定ボタンが見つからないため、候補クリック確定として続行');
  }

  await waitForFrameClose(page, promotionFrame, 10_000);

  await clickFirst(page, [
    'div.button-search input[type="submit"][value="検索する"]',
    'input[type="submit"][value="検索する"]',
    'input[type="submit"][value*="検索"]',
  ], '検索するボタン');
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null);
  await page.waitForTimeout(800);
}

async function downloadCsvWithUtf8(
  page: Page,
  kvStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
  adName: string,
): Promise<FileResult> {
  await clickFirst(page, [
    'p.btn.btn-csv a.thickbox[title="検索結果をCSVダウンロード"]',
    'a.thickbox[title="検索結果をCSVダウンロード"]',
    'a.thickbox[href*="action_log_rawExport"]',
  ], '検索結果をCSVダウンロードボタン');

  const csvFrame = await waitForFrameByUrlIncludes(page, 'action_log_rawExport', 15_000);
  if (!csvFrame) {
    throw new Error('CSVダウンロード設定モーダルを検出できません');
  }

  const utf8Radio = csvFrame.locator('input[name="csv_encoding"][value="UTF-8"]');
  await utf8Radio.waitFor({ state: 'visible', timeout: 10_000 });
  await utf8Radio.check();

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }),
    clickFirstInFrame(csvFrame, [
      'input[type="submit"][value="CSVファイルをダウンロード"]',
      'input.btn-send.btn-csv[type="submit"]',
      'input[type="submit"][value*="CSV"]',
    ], 'モーダルCSVダウンロードボタン'),
  ]);

  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('ダウンロードファイルのパス取得に失敗しました');
  }

  const raw = readFileSync(downloadPath);
  const content = decodeCsv(raw);
  const slug = slugify(adName);
  const timestamp = Date.now();
  const kvStoreKey = `csv_${aspId}_${slug}_${timestamp}`;

  await kvStore.setValue(kvStoreKey, content, { contentType: 'text/csv; charset=utf-8' });

  const suggested = download.suggestedFilename() || `${aspId}_${slug}_${timestamp}.csv`;

  return {
    adName,
    fileName: suggested,
    kvStoreKey,
    sizeBytes: raw.length,
  };
}

function decodeCsv(raw: Buffer): string {
  const asUtf8 = raw.toString('utf-8');
  if (!asUtf8.includes('\uFFFD')) {
    return asUtf8;
  }
  return iconv.decode(raw, 'Shift_JIS');
}

async function selectAdResultInFrame(frame: Frame, adName: string): Promise<void> {
  const firstLink = frame.locator('a', { hasText: adName }).first();
  if (await firstLink.count()) {
    await firstLink.click();
    return;
  }

  const row = frame.locator('tr', { hasText: adName }).first();
  if (await row.count()) {
    const radio = row.locator('input[type="radio"], input[type="checkbox"]').first();
    if (await radio.count()) {
      await radio.check().catch(async () => {
        await radio.click();
      });
      return;
    }
    const selectButton = row.locator('a:has-text("選択"), button:has-text("選択"), input[value*="選択"]').first();
    if (await selectButton.count()) {
      await selectButton.click();
      return;
    }
  }

  const textMatched = frame.getByText(adName).first();
  if (await textMatched.count()) {
    await textMatched.click();
    return;
  }

  throw new Error(`広告候補が見つかりません: ${adName}`);
}

async function waitForFrameByUrlIncludes(page: Page, needle: string, timeoutMs: number): Promise<Frame | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frames().find((f) => f.url().includes(needle));
    if (frame) return frame;
    await page.waitForTimeout(200);
  }
  return null;
}

async function waitForFrameClose(page: Page, frame: Frame, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exists = page.frames().some((f) => f === frame);
    if (!exists) return;
    await page.waitForTimeout(200);
  }
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

async function clickFirstInFrame(frame: Frame, selectors: string[], label: string): Promise<void> {
  for (const sel of selectors) {
    const loc = frame.locator(sel).first();
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

async function tryClickFirstInFrame(frame: Frame, selectors: string[], label: string): Promise<boolean> {
  for (const sel of selectors) {
    const loc = frame.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 2000 });
      await loc.click();
      log.info(`${label}: ${sel}`);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function fillFirstInFrame(
  frame: Frame,
  selectors: string[],
  value: string,
  label: string,
): Promise<void> {
  for (const sel of selectors) {
    const loc = frame.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 3000 });
      await loc.fill('');
      await loc.fill(value);
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
  const key = `screenshot_${aspId}_${label}_${Date.now()}`;
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
