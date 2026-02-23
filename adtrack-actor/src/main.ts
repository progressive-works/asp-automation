/**
 * アドトラック専用 Actor（①成果承認のみ）
 *
 * 処理フロー:
 *   1. ログイン（広告主ログイン: login_id2 / password2）
 *   2. 広告管理 → 成果承認へ遷移（sub_redirect使用）
 *   3. targetAdsをループ:
 *      案件選択 → ステータス「未承認」→ 検索 → CSV DL
 *
 * Input:
 *   - loginId: ログインID
 *   - password: パスワード
 *   - targetAds: 対象案件の配列 [{ value, label }]
 */
import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import iconv from 'iconv-lite';

interface InputSchema {
  loginId: string;
  password: string;
  targetAds: { value: string; label: string }[];
}

interface DownloadResult {
  adValue: string;
  adLabel: string;
  success: boolean;
  fileName?: string;
  error?: string;
}

await Actor.init();

const input = await Actor.getInput<InputSchema>();
if (!input?.loginId || !input?.password) {
  throw new Error('loginId and password are required');
}
if (!input.targetAds || input.targetAds.length === 0) {
  throw new Error('targetAds is required');
}

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
  // ===== Step 1: ログイン（広告主ログイン） =====
  log.info('ログインページへ遷移...');
  await page.goto('https://admin.ad-track.jp/report/index.php', {
    waitUntil: 'networkidle',
  });

  log.info('広告主ログインフォーム入力中...');
  await page.fill('input[name="login_id2"]', input.loginId);
  await page.fill('input[name="password2"]', input.password);

  await kvStore.setValue('screenshot-00-login', await page.screenshot({ fullPage: true }), {
    contentType: 'image/png',
  });

  // do_login(2) でログイン実行
  await page.evaluate(() => (window as any).do_login(2));
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  await page.waitForTimeout(3000);

  log.info(`ログイン後URL: ${page.url()}`);
  await kvStore.setValue('screenshot-01-after-login', await page.screenshot({ fullPage: true }), {
    contentType: 'image/png',
  });

  // ===== Step 2: 成果承認ページへ遷移 =====
  await navigateToApproval(page);

  await kvStore.setValue('screenshot-02-approval-page', await page.screenshot({ fullPage: true }), {
    contentType: 'image/png',
  });

  // ===== Step 3: 各案件をループ =====
  const results: DownloadResult[] = [];

  for (let i = 0; i < input.targetAds.length; i++) {
    const ad = input.targetAds[i];
    log.info(`\n========== [${i + 1}/${input.targetAds.length}] ${ad.label} ==========`);

    const result = await downloadApprovalCsv(page, ad, kvStore);
    results.push(result);
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
    mode: 'approval',
    executedAt: new Date().toISOString(),
    totalAds: input.targetAds.length,
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
    mode: 'approval',
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
//  ページ遷移（javascript:sub_redirect を使用）
// ============================================================

async function navigateToApproval(page: any): Promise<void> {
  log.info('遷移: 広告管理（CampaignList）');
  await page.evaluate(() => (window as any).sub_redirect('article/article/CampaignList'));
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  log.info('遷移: 成果承認（CvApprove）');
  await page.evaluate(() => (window as any).sub_redirect('article/affiliate/CvApprove'));
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
}


// ============================================================
//  成果承認 CSV ダウンロード
// ============================================================

async function downloadApprovalCsv(
  page: any,
  ad: { value: string; label: string },
  kvStore: any,
): Promise<DownloadResult> {
  try {
    log.info(`[成果承認] ${ad.label}`);

    // 成果承認ページへ遷移
    await navigateToApproval(page);

    // ステータス「未承認」ラジオボタン
    try {
      await page.click('input[type="radio"][value="0"]');
    } catch {
      log.warning('  未承認ラジオボタン(value=0)失敗、デフォルトのまま続行');
    }

    // 広告プルダウン選択
    await page.selectOption('select[name="article_id"]', ad.value);
    log.info(`  広告選択: ${ad.value}`);

    // 検索ボタン
    await clickSearch(page);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    await kvStore.setValue(
      `screenshot-approval-${ad.value}`,
      await page.screenshot({ fullPage: true }),
      { contentType: 'image/png' }
    );

    // CSV DL: input.btn_exp.excel → sub_export('excel')
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('input.btn_exp.excel').catch(() =>
        page.evaluate(() => (window as any).sub_export('excel'))
      ),
    ]);

    const filePath = await download.path();
    if (!filePath) throw new Error('DLパス取得失敗');

    const fs = await import('fs');
    const rawBuffer = fs.readFileSync(filePath);
    const fileName = `approval_${ad.value}.xls`;
    const key = `csv_approval_${ad.value}`;
    const csvContent = iconv.decode(rawBuffer, 'Shift_JIS');
    await kvStore.setValue(key, csvContent, { contentType: 'application/vnd.ms-excel' });

    log.info(`  保存: ${key} (${csvContent.length} bytes)`);
    return { adValue: ad.value, adLabel: ad.label, success: true, fileName };

  } catch (error: any) {
    log.error(`  [成果承認] 失敗: ${error.message}`);
    return { adValue: ad.value, adLabel: ad.label, success: false, error: error.message };
  }
}


// ============================================================
//  共通ヘルパー
// ============================================================

async function clickSearch(page: any): Promise<void> {
  const selectors = [
    'input[type="submit"][value="検索"]',
    'input[type="submit"][value*="検索"]',
    'button:has-text("検索")',
    'input[type="submit"]',
  ];
  await clickFirst(page, selectors, '検索ボタン');
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