/**
 * アドトラック専用 Actor
 *
 * 処理フロー:
 *   1. ログイン
 *   2. 成果承認ページから広告プルダウンの案件一覧を取得
 *   3. 各案件ごとにループ:
 *      a. ①成果承認ページ → 案件選択 → ステータス「未承認」→ 検索 → CSV DL
 *      b. ②成果一覧ページ → 案件選択 + 日付・ステータス設定 → 検索 → CSV DL
 *
 * Input:
 *   - loginId: ログインID
 *   - password: パスワード
 *   - dateFrom: 成果一覧の開始日（省略時: 1年前の今日）
 *   - dateTo: 成果一覧の終了日（省略時: 今日）
 *   - targetAds: 対象案件のvalue配列（省略時: 全案件）
 */
import { Actor, log } from 'apify';
import { chromium } from 'playwright';

interface InputSchema {
  loginId: string;
  password: string;
  dateFrom?: string;
  dateTo?: string;
  targetAds?: string[];
}

interface AdOption {
  value: string;
  label: string;
}

interface DownloadResult {
  adValue: string;
  adLabel: string;
  type: 'approval' | 'cvlist';
  success: boolean;
  fileName?: string;
  error?: string;
}

await Actor.init();

const input = await Actor.getInput<InputSchema>();
if (!input?.loginId || !input?.password) {
  throw new Error('loginId and password are required');
}

const today = new Date();
const oneYearAgo = new Date(today);
oneYearAgo.setFullYear(today.getFullYear() - 1);

const dateFrom = input.dateFrom || formatDate(oneYearAgo);
const dateTo = input.dateTo || formatDate(today);

log.info(`対象期間: ${dateFrom} ～ ${dateTo}`);

const kvStore = await Actor.openKeyValueStore();

log.info('ブラウザ起動中...');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  acceptDownloads: true,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});
context.setDefaultTimeout(60000);
const page = await context.newPage();

try {
  // ===== Step 1: ログイン =====
  log.info('ログインページへ遷移...');
  await page.goto('https://admin.ad-track.jp/report/index.php', {
    waitUntil: 'networkidle',
  });

  const loginForm = await page.$('input[type="password"]');
  if (loginForm) {
    log.info('ログインフォーム入力中...');

    const idSelectors = [
      'input[name="userId"]',
      'input[name="login_id"]',
      'input[name="email"]',
      'input[name="id"]',
      'input[type="text"]:first-of-type',
    ];
    await fillFirst(page, idSelectors, input.loginId, 'ログインID');
    await page.fill('input[type="password"]', input.password);

    await kvStore.setValue('screenshot-00-login', await page.screenshot({ fullPage: true }), {
      contentType: 'image/png',
    });

    const submitSelectors = [
      'input[type="submit"]',
      'button[type="submit"]',
      'input[name="login"]',
      'button:has-text("ログイン")',
    ];
    await clickFirst(page, submitSelectors, 'ログインボタン');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
  }

  log.info(`ログイン後URL: ${page.url()}`);
  await kvStore.setValue('screenshot-01-after-login', await page.screenshot({ fullPage: true }), {
    contentType: 'image/png',
  });

  // ===== Step 2: 成果承認ページから案件一覧を取得 =====
  log.info('成果承認ページへ遷移...');
  await page.goto(
    'https://admin.ad-track.jp/report/index.php?a=article/affiliate/CvApprove',
    { waitUntil: 'networkidle' }
  );

  await kvStore.setValue('screenshot-02-approval-page', await page.screenshot({ fullPage: true }), {
    contentType: 'image/png',
  });

  const adOptions = await getAdOptions(page);
  log.info(`案件数: ${adOptions.length}`);
  adOptions.forEach((ad) => log.info(`  - [${ad.value}] ${ad.label}`));

  const targetAds = input.targetAds && input.targetAds.length > 0
    ? adOptions.filter((ad) => input.targetAds!.includes(ad.value))
    : adOptions;

  log.info(`処理対象: ${targetAds.length}件`);

  // ===== Step 3: 各案件をループ =====
  const results: DownloadResult[] = [];

  for (let i = 0; i < targetAds.length; i++) {
    const ad = targetAds[i];
    log.info(`\n========== [${i + 1}/${targetAds.length}] ${ad.label} ==========`);

    // ── ①成果承認 CSV ──
    const approvalResult = await downloadApprovalCsv(page, ad, kvStore);
    results.push(approvalResult);
    await page.waitForTimeout(2000);

    // ── ②成果一覧 CSV ──
    const cvlistResult = await downloadCvListCsv(page, ad, dateFrom, dateTo, kvStore);
    results.push(cvlistResult);
    await page.waitForTimeout(2000);
  }

  // ===== 結果サマリー =====
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  log.info(`\n========================================`);
  log.info(`完了: ${successCount} 成功, ${failCount} 失敗 (全${results.length}件)`);
  log.info(`========================================`);

  await Actor.pushData({
    aspName: 'アドトラック',
    executedAt: new Date().toISOString(),
    dateFrom,
    dateTo,
    totalAds: targetAds.length,
    totalDownloads: results.length,
    successCount,
    failureCount: failCount,
    results,
  });

} catch (error: any) {
  log.error(`致命的エラー: ${error.message}`);
  await kvStore.setValue('screenshot-error', await page.screenshot({ fullPage: true }), {
    contentType: 'image/png',
  });
  await Actor.pushData({
    aspName: 'アドトラック',
    status: 'fatal_error',
    error: error.message,
    timestamp: new Date().toISOString(),
  });
} finally {
  await browser.close();
  log.info('ブラウザ終了');
}

await Actor.exit();


// ============================================================
//  ①成果承認 CSV ダウンロード
// ============================================================
async function downloadApprovalCsv(
  page: any,
  ad: AdOption,
  kvStore: any,
): Promise<DownloadResult> {
  try {
    log.info(`[①成果承認] ${ad.label}`);

    await page.goto(
      'https://admin.ad-track.jp/report/index.php?a=article/affiliate/CvApprove',
      { waitUntil: 'networkidle' }
    );

    // ステータス「未承認」ラジオボタン
    try {
      await page.click('input[type="radio"][value="0"]');
    } catch {
      log.warning('  未承認ラジオボタン(value=0)失敗、デフォルトのまま続行');
    }

    // 広告プルダウン選択
    await selectAd(page, ad.value);

    // 検索
    await clickSearch(page);
    await page.waitForLoadState('networkidle');

    await kvStore.setValue(
      `screenshot-approval-${ad.value}`,
      await page.screenshot({ fullPage: true }),
      { contentType: 'image/png' }
    );

    // CSV DL
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      clickCsvButton(page),
    ]);

    const filePath = await download.path();
    if (!filePath) throw new Error('DLパス取得失敗');

    const fs = await import('fs');
    const rawBuffer = fs.readFileSync(filePath);
    const suggestedName = download.suggestedFilename();
    const fileName = `approval_${ad.value}_${suggestedName}`;
    const key = `csv_approval_${ad.value}`;
    await kvStore.setValue(key, rawBuffer, { contentType: 'text/csv' });

    log.info(`  保存: ${key} (${rawBuffer.length} bytes)`);
    return { adValue: ad.value, adLabel: ad.label, type: 'approval', success: true, fileName };

  } catch (error: any) {
    log.error(`  [①成果承認] 失敗: ${error.message}`);
    return { adValue: ad.value, adLabel: ad.label, type: 'approval', success: false, error: error.message };
  }
}


// ============================================================
//  ②成果一覧 CSV ダウンロード
// ============================================================
async function downloadCvListCsv(
  page: any,
  ad: AdOption,
  dateFrom: string,
  dateTo: string,
  kvStore: any,
): Promise<DownloadResult> {
  try {
    log.info(`[②成果一覧] ${ad.label} (${dateFrom} ～ ${dateTo})`);

    await page.goto(
      'https://admin.ad-track.jp/report/index.php?a=report/cv/CvList',
      { waitUntil: 'networkidle' }
    );

    // 日付入力
    const dateFromSelectors = [
      'input[name="date_from"]', 'input[name="start_date"]', 'input[name="sdate"]',
    ];
    const dateToSelectors = [
      'input[name="date_to"]', 'input[name="end_date"]', 'input[name="edate"]',
    ];
    await fillFirstDate(page, dateFromSelectors, dateFrom, '開始日');
    await fillFirstDate(page, dateToSelectors, dateTo, '終了日');

    // ステータス: 未承認チェックボックス
    try {
      const statusCheckboxes = await page.$$('input[name="status[]"], input[name*="status"]');
      for (const cb of statusCheckboxes) {
        if (await cb.isChecked()) await cb.uncheck();
      }
      await page.check('input[type="checkbox"][value="0"]').catch(() => {
        log.warning('  ステータス未承認チェック失敗');
      });
    } catch {
      log.warning('  ステータス設定スキップ');
    }

    // 広告プルダウン選択
    await selectAd(page, ad.value);

    // 検索
    await clickSearch(page);
    await page.waitForLoadState('networkidle');

    await kvStore.setValue(
      `screenshot-cvlist-${ad.value}`,
      await page.screenshot({ fullPage: true }),
      { contentType: 'image/png' }
    );

    // CSV DL
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      clickCsvButton(page),
    ]);

    const filePath = await download.path();
    if (!filePath) throw new Error('DLパス取得失敗');

    const fs = await import('fs');
    const rawBuffer = fs.readFileSync(filePath);
    const suggestedName = download.suggestedFilename();
    const fileName = `cvlist_${ad.value}_${suggestedName}`;
    const key = `csv_cvlist_${ad.value}`;
    await kvStore.setValue(key, rawBuffer, { contentType: 'text/csv' });

    log.info(`  保存: ${key} (${rawBuffer.length} bytes)`);
    return { adValue: ad.value, adLabel: ad.label, type: 'cvlist', success: true, fileName };

  } catch (error: any) {
    log.error(`  [②成果一覧] 失敗: ${error.message}`);
    return { adValue: ad.value, adLabel: ad.label, type: 'cvlist', success: false, error: error.message };
  }
}


// ============================================================
//  共通ヘルパー
// ============================================================

async function getAdOptions(page: any): Promise<AdOption[]> {
  const adSelect = await page.$$eval(
    'select[name="article_id"] option',
    (opts: HTMLOptionElement[]) =>
      opts
        .filter((o) => o.value && o.value !== '')
        .map((o) => ({ value: o.value, label: o.textContent?.trim() || '' })),
  );

  if (adSelect.length > 0) {
    log.info(`広告プルダウン検出: select[name="article_id"] (${adSelect.length}件)`);
    return adSelect;
  }

  throw new Error('広告プルダウン(article_id)が見つかりません');
}

async function selectAd(page: any, value: string): Promise<void> {
  await page.selectOption('select[name="article_id"]', value);
  log.info(`  広告選択: select[name="article_id"] = ${value}`);
}

async function clickSearch(page: any): Promise<void> {
  const selectors = [
    'input[type="submit"][value="検索"]',
    'input[type="submit"][value*="検索"]',
    'button:has-text("検索")',
    'input[type="submit"]',
  ];
  await clickFirst(page, selectors, '検索ボタン');
}

async function clickCsvButton(page: any): Promise<void> {
  // スクショの右上にあるアイコンボタン（Excelアイコン的なもの）
  const selectors = [
    'a:has-text("CSV")',
    'button:has-text("CSV")',
    'a[href*="csv"]',
    'a[href*="CSV"]',
    'a[href*="download"]',
    'a[href*="export"]',
    'img[alt*="CSV"]',
    'img[alt*="csv"]',
    // スクショにある緑のExcelっぽいアイコン
    'a img[src*="csv"]',
    'a img[src*="excel"]',
    'a img[src*="xls"]',
  ];
  await clickFirst(page, selectors, 'CSVボタン');
}

async function fillFirstDate(
  page: any, selectors: string[], value: string, label: string,
): Promise<void> {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await page.evaluate((s: string) => {
          const input = document.querySelector(s) as HTMLInputElement;
          if (input) input.value = '';
        }, sel);
        await page.fill(sel, value);
        log.info(`  ${label}: ${sel} = ${value}`);
        return;
      }
    } catch { /* 次 */ }
  }
  log.warning(`  ${label} 入力欄が見つかりません`);
}

async function fillFirst(
  page: any, selectors: string[], value: string, label: string,
): Promise<void> {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 2000 });
      if (el) {
        await page.fill(sel, value);
        log.info(`  ${label}: ${sel}`);
        return;
      }
    } catch { /* 次 */ }
  }
  throw new Error(`${label} が見つかりません`);
}

async function clickFirst(
  page: any, selectors: string[], label: string,
): Promise<void> {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await el.click();
        log.info(`  ${label}: ${sel}`);
        return;
      }
    } catch { /* 次 */ }
  }
  throw new Error(`${label} が見つかりません`);
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
