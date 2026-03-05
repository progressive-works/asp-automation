import { Actor, log } from 'apify';
import { chromium, Page } from 'playwright';
import { readFileSync } from 'fs';
import iconv from 'iconv-lite';

interface InputSchema {
  username: string;
  password: string;
}

interface FileResult {
  fileName: string;
  kvStoreKey: string;
  sizeBytes: number;
}

const BASE_URL = 'https://portal.gro-fru.net';
const ADMIN_URL = `${BASE_URL}/admin/`;
const ACTION_LIST_URL = `${BASE_URL}/admin/log/action/list`;
const DEFAULT_TIMEOUT = 60_000;
const DOWNLOAD_TIMEOUT = 30_000;

await Actor.init();

const input = await Actor.getInput<InputSchema>();
if (!input?.username || !input?.password) {
  throw new Error('username and password are required');
}

const kvStore = await Actor.openKeyValueStore();
const files: FileResult[] = [];
const screenshotKeys: string[] = [];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  acceptDownloads: true,
  httpCredentials: {
    username: input.username,
    password: input.password,
  },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});
context.setDefaultTimeout(DEFAULT_TIMEOUT);
const page = await context.newPage();

try {
  // 1. ログイン（HTTP Basic認証で自動通過）
  await login(page);
  await saveScreenshot(kvStore, page, screenshotKeys, 'post-login');

  // 2. 成果ログページへ遷移
  log.info('成果ログページへ遷移');
  await page.goto(ACTION_LIST_URL, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
  await saveScreenshot(kvStore, page, screenshotKeys, 'action-list');

  // 3. 絞り込み検索パネルを開く
  await openSearchPanel(page);
  await saveScreenshot(kvStore, page, screenshotKeys, 'search-panel-open');

  // 4. 検索条件を入力
  await setSearchConditions(page);
  await saveScreenshot(kvStore, page, screenshotKeys, 'search-conditions-set');

  // 5. 検索実行
  await clickFirst(page, [
    'input[type="submit"][name="search"]',
    'button[type="submit"]',
    'input[type="submit"]',
  ], '検索ボタン');
  await page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT });
  await saveScreenshot(kvStore, page, screenshotKeys, 'search-results');

  // 6-7. CSV生成 & 保存
  await downloadCsv(page, kvStore);

  const status = files.length > 0 ? 'SUCCESS' : 'NO_DATA';

  await Actor.pushData({
    aspId: 'grofru',
    aspName: 'Gro-fru',
    status,
    files,
    processedAds: 1,
    succeededAds: files.length > 0 ? 1 : 0,
    failedAds: 0,
    screenshotKeys,
    executedAt: new Date().toISOString(),
  });
} catch (error: any) {
  const reason = error?.message || 'unknown fatal error';
  log.error(`致命的エラー: ${reason}`);
  await saveScreenshot(kvStore, page, screenshotKeys, 'fatal-error');

  await Actor.pushData({
    aspId: 'grofru',
    aspName: 'Gro-fru',
    status: 'FAILED',
    files,
    failures: [
      {
        step: 'fatal',
        reason,
      },
    ],
    processedAds: 1,
    succeededAds: 0,
    failedAds: 1,
    screenshotKeys,
    executedAt: new Date().toISOString(),
  });
} finally {
  await browser.close();
  await Actor.exit();
}

// --- 関数定義 ---

async function login(page: Page): Promise<void> {
  log.info('管理画面へ遷移（HTTP Basic認証）');
  await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
  log.info(`ログイン後URL: ${page.url()}`);
}

async function openSearchPanel(page: Page): Promise<void> {
  log.info('絞り込み検索パネルを開く');
  await clickFirst(page, [
    'button#searchFormOpen',
    '#searchFormOpen',
    'button:has-text("絞り込み検索")',
  ], '絞り込み検索ボタン');
  // パネルが開くのを待つ
  await page.waitForTimeout(500);
}

async function setSearchConditions(page: Page): Promise<void> {
  log.info('検索条件を設定');

  // 登録日時: 1年前～当日（JST基準）
  const nowJst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const oneYearAgoJst = new Date(nowJst);
  oneYearAgoJst.setFullYear(oneYearAgoJst.getFullYear() - 1);

  const formatDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}年${m}月${dd}日`;
  };

  const dateRange = `${formatDate(oneYearAgoJst)} - ${formatDate(nowJst)}`;
  log.info(`日付範囲: ${dateRange}`);

  // daterangeピッカーに直接入力（#searchAt で一意指定）
  const dateInput = page.locator('input#searchAt');
  await dateInput.click();
  await dateInput.fill(dateRange);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  // ステータス: 承認待ち(1)のみチェック
  // iCheckライブラリ対応: 親divまたはhelperをクリック
  log.info('ステータス「承認待ち」を選択');

  // 承認待ち(value=1) → チェックON
  await setICheck(page, 'input#searchContentAliveStastus1', true);
  // 承認(value=2) → チェックOFF
  await setICheck(page, 'input#searchContentAliveStastus2', false);
  // 否認(value=3) → チェックOFF
  await setICheck(page, 'input#searchContentAliveStastus3', false);
}

async function setICheck(page: Page, selector: string, shouldBeChecked: boolean): Promise<void> {
  const input = page.locator(selector);
  const isChecked = await input.isChecked().catch(() => false);

  if (isChecked === shouldBeChecked) {
    log.info(`${selector}: 既に${shouldBeChecked ? 'チェック済み' : '未チェック'}`);
    return;
  }

  // iCheckライブラリ: inputは非表示なのでPlaywrightの.check()/.uncheck()を試す
  try {
    if (shouldBeChecked) {
      await input.check({ timeout: 3000 });
    } else {
      await input.uncheck({ timeout: 3000 });
    }
    log.info(`${selector}: ${shouldBeChecked ? 'チェック' : 'アンチェック'}成功（直接操作）`);
    return;
  } catch {
    log.info(`${selector}: 直接操作失敗、親要素クリックを試行`);
  }

  // 親の .icheckbox_flat-blue をクリック
  try {
    const parent = page.locator(`${selector}`).locator('xpath=ancestor::div[contains(@class,"icheckbox")]');
    await parent.click({ timeout: 3000 });
    log.info(`${selector}: 親divクリック成功`);
    return;
  } catch {
    log.info(`${selector}: 親divクリック失敗、iCheck-helperを試行`);
  }

  // 隣接の .iCheck-helper をクリック
  try {
    const helper = page.locator(`${selector} ~ .iCheck-helper`);
    await helper.click({ timeout: 3000 });
    log.info(`${selector}: iCheck-helperクリック成功`);
    return;
  } catch {
    log.warning(`${selector}: すべてのクリック方法が失敗`);
  }
}

async function downloadCsv(
  page: Page,
  kvStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
): Promise<void> {
  // CSV生成ボタンの存在確認
  const csvButton = page.locator('button:has-text("CSV生成")').first();
  const csvButtonAlt = page.locator('button[onclick*="csv"]').first();
  const csvButtonSubmit = page.locator('button.submit-safety').first();

  let foundButton = false;
  for (const btn of [csvButton, csvButtonAlt, csvButtonSubmit]) {
    try {
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      foundButton = true;

      log.info('CSV生成ボタンを検出、ダウンロード開始');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }),
        btn.click(),
      ]);

      const downloadPath = await download.path();
      if (!downloadPath) {
        throw new Error('ダウンロードファイルのパス取得に失敗しました');
      }

      const raw = readFileSync(downloadPath);
      const content = decodeCsv(raw);
      const timestamp = Date.now();
      const kvStoreKey = `csv_grofru_${timestamp}`;

      await kvStore.setValue(kvStoreKey, content, { contentType: 'text/csv; charset=utf-8' });

      const suggested = download.suggestedFilename() || `grofru_${timestamp}.csv`;

      files.push({
        fileName: suggested,
        kvStoreKey,
        sizeBytes: raw.length,
      });

      log.info(`CSV保存完了: ${kvStoreKey} (${raw.length} bytes)`);
      await saveScreenshot(kvStore, page, screenshotKeys, 'csv-downloaded');
      return;
    } catch {
      // try next button
    }
  }

  if (!foundButton) {
    log.info('CSV生成ボタンが見つかりません（検索結果0件の可能性）');
    await saveScreenshot(kvStore, page, screenshotKeys, 'no-csv-button');
  }
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
  const key = `screenshot_grofru_${label}_${Date.now()}`;
  const image = await page.screenshot({ fullPage: true }).catch(() => null);
  if (!image) return;
  await kvStore.setValue(key, image, { contentType: 'image/png' });
  screenshotKeys.push(key);
}
