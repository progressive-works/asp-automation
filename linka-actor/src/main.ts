import { Actor, log } from 'apify';
import { chromium, Page } from 'playwright';
import { readFileSync } from 'fs';
import iconv from 'iconv-lite';

interface InputSchema {
  loginId: string;
  password: string;
  dateFrom?: string; // YYYY-MM-DD デフォルト: 1年前
}

interface FileResult {
  fileName: string;
  kvStoreKey: string;
  sizeBytes: number;
}

const LOGIN_URL = 'https://link-ag.net/';
const ACHIEVEMENTS_URL = 'https://link-ag.net/client/achievements';
const DOWNLOAD_HISTORY_URL = 'https://link-ag.net/client/csv_download_histories';
const DEFAULT_TIMEOUT = 60_000;
const DOWNLOAD_TIMEOUT = 30_000;

await Actor.init();

const input = await Actor.getInput<InputSchema>();
if (!input?.loginId || !input?.password) {
  throw new Error('loginId and password are required');
}

// デフォルト: 1年前
const now = new Date();
const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
const dateFrom = input.dateFrom || formatDate(oneYearAgo);

const kvStore = await Actor.openKeyValueStore();
const files: FileResult[] = [];
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
  // 1. ログイン
  await login(page, input.loginId, input.password);
  await saveScreenshot(page, 'post-login');

  // 2. 成果一覧ページに遷移
  log.info('成果一覧ページへ遷移');
  await page.goto(ACHIEVEMENTS_URL, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
  await saveScreenshot(page, 'achievements-page');

  // 3. 検索条件設定
  await setSearchFilters(page, dateFrom);
  await saveScreenshot(page, 'after-filter');

  // 4. 検索実行
  await clickFirst(page, ['#q_submit'], '検索ボタン');
  await page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => null);
  await page.waitForTimeout(2000);
  await saveScreenshot(page, 'after-search');

  // 結果0件判定
  const noResults = await page.locator('td:has-text("表示する成果はありません")').first()
    .isVisible()
    .catch(() => false);

  if (noResults) {
    log.info('検索結果0件のためCSVダウンロードをスキップ');
    await Actor.pushData({
      aspId: 'linka',
      aspName: 'Link-A Global',
      status: 'SUCCESS',
      files: [],
      failures: [],
      screenshotKeys,
      executedAt: new Date().toISOString(),
      note: '検索結果0件',
    });
  } else {
    // 5. CSVダウンロードリクエスト
    log.info('CSVエクスポートボタンをクリック');
    await clickFirst(page, ['#js-csv-export-btn'], 'CSVエクスポートボタン');

    // ページ遷移を待機（ダウンロード履歴ページへ）
    await page.waitForURL('**/csv_download_histories**', { timeout: DEFAULT_TIMEOUT }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => null);
    await page.waitForTimeout(2000);
    await saveScreenshot(page, 'download-history');

    // 6. ダウンロード履歴からCSV取得
    log.info('ダウンロード履歴からCSVを取得');

    // 最新レコードのダウンロードリンクをクリック
    const downloadLink = page.locator('table.table-striped tbody tr:first-child a.btn-success').first();
    await downloadLink.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }),
      downloadLink.click(),
    ]);

    const downloadPath = await download.path();
    if (!downloadPath) {
      throw new Error('ダウンロードファイルのパス取得に失敗しました');
    }

    const raw = readFileSync(downloadPath);
    const content = decodeCsv(raw);
    const timestamp = Date.now();
    const kvStoreKey = `csv_linka_${timestamp}`;

    await kvStore.setValue(kvStoreKey, content, { contentType: 'text/csv; charset=utf-8' });

    const suggested = download.suggestedFilename() || `linka_${timestamp}.csv`;

    files.push({
      fileName: suggested,
      kvStoreKey,
      sizeBytes: raw.length,
    });

    log.info(`CSV保存完了: ${kvStoreKey} (${raw.length} bytes)`);

    await Actor.pushData({
      aspId: 'linka',
      aspName: 'Link-A Global',
      status: 'SUCCESS',
      files,
      failures: [],
      screenshotKeys,
      executedAt: new Date().toISOString(),
    });
  }
} catch (error: any) {
  const reason = error?.message || 'unknown fatal error';
  log.error(`致命的エラー: ${reason}`);
  await saveScreenshot(page, 'fatal-error');

  await Actor.pushData({
    aspId: 'linka',
    aspName: 'Link-A Global',
    status: 'FAILED',
    files,
    failures: [
      {
        step: 'fatal',
        reason,
      },
    ],
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
  await saveScreenshot(page, 'login-page');

  await page.fill('#login_id', loginId);
  await page.fill('#password', password);

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => null),
    clickFirst(page, [
      'input[type="submit"][name="commit"]',
    ], 'ログインボタン'),
  ]);

  await page.waitForTimeout(2000);

  // ログイン成功判定: URLが変わったか
  if (page.url() === LOGIN_URL || page.url().includes('/login')) {
    throw new Error(`ログイン失敗: ${page.url()}`);
  }
  log.info(`ログイン成功: ${page.url()}`);
}

async function setSearchFilters(page: Page, dateFrom: string): Promise<void> {
  log.info(`検索条件設定: 発生日時from=${dateFrom}`);

  // 発生日時 from を設定（datepicker対策でevaluateで直接書き換え）
  await page.evaluate((date) => {
    const input = document.querySelector('#js-occurrence_time-range-start') as HTMLInputElement | null;
    if (input) {
      input.value = date;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, dateFrom);

  await page.waitForTimeout(500);

  // 承認状況チェックボックス操作
  // 承認済のチェックを外す
  await uncheckIfChecked(page, '#status_approved', '承認済');
  // 否認のチェックを外す
  await uncheckIfChecked(page, '#status_rejected', '否認');
  // 未承認はチェック済みのまま確認
  const unapprovedChecked = await page.isChecked('#status_unapproved').catch(() => false);
  if (!unapprovedChecked) {
    log.info('未承認チェックボックスをチェック');
    await page.check('#status_unapproved');
  }

  await page.waitForTimeout(500);
}

async function uncheckIfChecked(page: Page, selector: string, label: string): Promise<void> {
  const checked = await page.isChecked(selector).catch(() => false);
  if (checked) {
    log.info(`${label}チェックボックスを外す`);
    await page.uncheck(selector);
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

async function saveScreenshot(page: Page, label: string): Promise<void> {
  const key = `screenshot_linka_${label}_${Date.now()}`;
  const image = await page.screenshot({ fullPage: true }).catch(() => null);
  if (!image) return;
  await kvStore.setValue(key, image, { contentType: 'image/png' });
  screenshotKeys.push(key);
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
