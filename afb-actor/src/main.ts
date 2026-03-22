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

const LOGIN_URL = 'https://www.afi-b.com/general/client/completedlogout';
const APPROVAL_URL = 'https://client.afi-b.com/client/b/cl/approval/';
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
        await downloadCsvForProgram(page, kvStore, ad, slug);
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
            programId: ad.value,
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
    aspId: 'afb',
    aspName: 'AFB',
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
    aspId: 'afb',
    aspName: 'AFB',
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

  await page.fill('input#remUserEmail', loginId);
  await page.fill('input#remSiteUrl', password);

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => null),
    clickFirst(page, [
      'input[type="submit"][value="ログイン"]',
      'input.m-btn__submit',
      'input[type="submit"]',
      'button[type="submit"]',
    ], 'ログインボタン'),
  ]);

  await page.waitForTimeout(2000);

  if (page.url().includes('failedlogin') || page.url().includes('completedlogout')) {
    throw new Error(`ログイン失敗: ${page.url()}`);
  }
  log.info(`ログイン成功: ${page.url()}`);
}

async function downloadCsvForProgram(
  page: Page,
  kvStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
  ad: TargetAd,
  slug: string,
): Promise<void> {
  log.info(`成果承認ページへ遷移: ${ad.label}`);
  await page.goto(APPROVAL_URL, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
  await page.waitForTimeout(1000);
  await saveScreenshot(kvStore, page, screenshotKeys, `approval-page-${slug}`);

  // プロモーション選択（jQuery Chosen プラグイン対応）
  await selectChosenOption(page, ad.value, ad.label);
  await page.waitForTimeout(500);
  await saveScreenshot(kvStore, page, screenshotKeys, `after-select-${slug}`);

  // 開始日を1年前の1日に設定
  const now = new Date();
  const startYear = now.getFullYear() - 1;
  const startMonth = String(now.getMonth() + 1).padStart(2, '0');
  const startDate = `${startYear}/${startMonth}/01`;
  log.info(`開始日を設定: ${startDate}`);

  await page.evaluate((date) => {
    const input = document.querySelector('#form_start_date') as HTMLInputElement | null;
    if (input) {
      input.value = date;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, startDate);

  await page.waitForTimeout(500);
  await saveScreenshot(kvStore, page, screenshotKeys, `after-date-${slug}`);

  // 「レポートを表示する」ボタンをクリック
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => null),
    clickFirst(page, [
      'input[name="search"][type="submit"]',
      'input[data-testid="approval-display-report"]',
      'input[value="レポートを表示する"]',
    ], 'レポート表示ボタン'),
  ]);

  await page.waitForTimeout(2000);
  await saveScreenshot(kvStore, page, screenshotKeys, `after-search-${slug}`);

  // 検索結果が0件の場合はスキップ
  const noData = await page.locator('#error_message').first()
    .isVisible()
    .catch(() => false);

  if (noData) {
    const errorText = await page.locator('#error_message').first().textContent().catch(() => '');
    if (errorText?.includes('該当するデータが見つかりませんでした')) {
      log.info(`検索結果0件のためスキップ: ${ad.label}`);
      return;
    }
  }

  // CSVダウンロードボタンをクリック
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }),
    clickFirst(page, [
      'input#csv_dl',
      'input[name="csv_dl"]',
      '[data-testid="approval-CSV-download"] input[type="submit"]',
    ], 'CSVダウンロードボタン'),
  ]);

  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('ダウンロードファイルのパス取得に失敗しました');
  }

  const raw = readFileSync(downloadPath);
  const content = decodeCsv(raw);
  const timestamp = Date.now();
  const kvStoreKey = `csv_afb_${slug}_${timestamp}`;

  await kvStore.setValue(kvStoreKey, content, { contentType: 'text/csv; charset=utf-8' });

  const suggested = download.suggestedFilename() || `afb_${slug}_${timestamp}.csv`;

  files.push({
    adName: ad.label,
    programId: ad.value,
    fileName: suggested,
    kvStoreKey,
    sizeBytes: raw.length,
  });

  log.info(`CSV保存完了: ${kvStoreKey} (${raw.length} bytes)`);
}

async function selectChosenOption(page: Page, value: string, label: string): Promise<void> {
  log.info(`プロモーション選択: ${label} (value=${value})`);

  // 方法1: 裏のselect要素に直接値をセットし、Chosen UIを更新
  const set = await page.evaluate((val) => {
    const selectors = ['#client_promotion', 'select[name="client_promotion"]'];
    for (const sel of selectors) {
      const select = document.querySelector(sel) as HTMLSelectElement | null;
      if (select) {
        select.value = val;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        try {
          (window as any).jQuery?.(select).trigger('chosen:updated');
        } catch { /* no jQuery */ }
        return true;
      }
    }
    // fallback: 全selectから探す
    const allSelects = document.querySelectorAll('select');
    for (const s of allSelects) {
      for (const opt of s.options) {
        if (opt.value === val) {
          s.value = val;
          s.dispatchEvent(new Event('change', { bubbles: true }));
          try {
            (window as any).jQuery?.(s).trigger('chosen:updated');
          } catch { /* no jQuery */ }
          return true;
        }
      }
    }
    return false;
  }, value);

  if (set) {
    log.info('プロモーション選択完了（evaluate経由）');
    return;
  }

  // 方法2: Chosen UIをクリックして操作
  log.info('evaluate失敗、Chosen UIで選択を試行');
  const chosenContainer = page.locator('#client_promotion_chzn, .chosen-container').first();
  await chosenContainer.click();
  await page.waitForTimeout(300);

  // Chosen検索が有効な場合は入力
  const searchInput = chosenContainer.locator('.chosen-search input');
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(label);
    await page.waitForTimeout(300);
  }

  // 結果リストからクリック
  const resultItem = chosenContainer.locator(`.chosen-results li:has-text("${label}")`).first();
  await resultItem.click();
  log.info('プロモーション選択完了（Chosen UI経由）');
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
  const key = `screenshot_afb_${label}_${Date.now()}`;
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
