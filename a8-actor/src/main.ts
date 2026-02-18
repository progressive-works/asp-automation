import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import iconv from 'iconv-lite';

interface InputSchema {
  loginId: string;
  password: string;
}

await Actor.init();

const input = await Actor.getInput<InputSchema>();
if (!input?.loginId || !input?.password) {
  throw new Error('loginId and password are required');
}

const kvStore = await Actor.openKeyValueStore();

log.info('Launching browser...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  // ===== Step 1: ログイン =====
  log.info('Navigating to login page...');
  await page.goto('https://adv-console.a8.net/login', {
    waitUntil: 'networkidle',
  });

  log.info('Filling login form...');
  await page.fill('input[name="userId"]', input.loginId);
  await page.fill('input[name="password"]', input.password);
  await page.click('input[name="ecLogin"]');
  await page.waitForLoadState('networkidle', { timeout: 30000 });

  const loginUrl = page.url();
  log.info(`Login completed. Current URL: ${loginUrl}`);

  // ===== Step 2: 成果確定ページへ遷移 =====
  log.info('Navigating to order confirmation page...');
  await page.goto('https://adv-console.a8.net/order/order-confirmation/', {
    waitUntil: 'networkidle',
  });

  await kvStore.setValue('screenshot-01-confirmation-page', await page.screenshot({ fullPage: true }), {
    contentType: 'image/png',
  });

  // ===== Step 3: CSVダウンロードリンクを全取得 =====
  const csvLinks = await page.$$eval('td.download.reward a', (anchors) =>
    anchors.map((a) => {
      const href = a.getAttribute('href') || '';
      const match = href.match(/order-confirmation\/(s\d+)\/download/);
      return {
        href,
        programId: match ? match[1] : 'unknown',
      };
    })
  );

  log.info(`Found ${csvLinks.length} CSV download links`);

  // ===== Step 4: プログラム名も取得 =====
  const programNames = await page.$$eval(
    'td a[href*="/processing"]',
    (anchors) =>
      anchors.map((a) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/order-confirmation\/(s\d+)\/processing/);
        return {
          programId: match ? match[1] : 'unknown',
          name: a.textContent?.trim() || '',
        };
      })
  );

  // ===== Step 5: 各プログラムのCSVをダウンロード =====
  const results: Array<{
    programId: string;
    programName: string;
    success: boolean;
    error?: string;
  }> = [];

  for (const csvLink of csvLinks) {
    const programInfo = programNames.find((p) => p.programId === csvLink.programId);
    const programName = programInfo?.name || csvLink.programId;

    try {
      log.info(`Downloading CSV: ${programName} (${csvLink.programId})`);

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.click(`td.download.reward a[href="${csvLink.href}"]`),
      ]);

      const filePath = await download.path();
      if (filePath) {
        const fs = await import('fs');
        const rawBuffer = fs.readFileSync(filePath);
        const csvContent = iconv.decode(rawBuffer, 'Shift_JIS');

        const key = `csv_${csvLink.programId}`;
        await kvStore.setValue(key, csvContent, {
          contentType: 'text/csv',
        });

        log.info(`Saved: ${key} (${csvContent.length} bytes)`);
        results.push({ programId: csvLink.programId, programName, success: true });
      }

      await page.waitForTimeout(2000);
    } catch (error: any) {
      log.error(`Failed: ${csvLink.programId} - ${error.message}`);
      results.push({
        programId: csvLink.programId,
        programName,
        success: false,
        error: error.message,
      });
    }
  }

  // ===== 結果サマリー =====
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  log.info(`Download complete: ${successCount} succeeded, ${failCount} failed`);

  await Actor.pushData({
    aspName: 'A8.net',
    executedAt: new Date().toISOString(),
    totalPrograms: results.length,
    successCount,
    failureCount: failCount,
    results,
  });

} catch (error: any) {
  log.error(`Fatal error: ${error.message}`);

  await kvStore.setValue('screenshot-error', await page.screenshot({ fullPage: true }), {
    contentType: 'image/png',
  });

  await Actor.pushData({
    status: 'fatal_error',
    error: error.message,
    timestamp: new Date().toISOString(),
  });
} finally {
  await browser.close();
}

await Actor.exit();
