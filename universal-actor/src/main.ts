/**
 * 汎用 ASP CSVダウンローダー
 *
 * スプレッドシートから渡される steps 定義に従い、
 * 任意のASP管理画面からCSVをダウンロードする。
 *
 * 既存A8 Actorとは別に動作し、n8nから個別にRunされる。
 *
 * Input例（アドトラック）:
 * {
 *   "aspId": "ASP_ADTRACK",
 *   "aspName": "アドトラック",
 *   "loginUrl": "https://af.ad-track.jp/publisher/login",
 *   "loginId": "your-id",
 *   "loginPassword": "your-pass",
 *   "encoding": "utf-8",
 *   "steps": [
 *     { "action": "goto", "url": "https://af.ad-track.jp/publisher/report" },
 *     { "action": "fill", "selector": "#date-from", "value": "{{lastMonthStart}}" },
 *     { "action": "fill", "selector": "#date-to", "value": "{{lastMonthEnd}}" },
 *     { "action": "click", "selector": "#btn-search", "waitAfter": 3000 },
 *     { "action": "downloadClick", "selector": "#csv-download" }
 *   ]
 * }
 */
import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import type { ActorInput, ActorOutput } from './types.js';
import { executeSteps, StepContext } from './step-executor.js';

await Actor.init();

// ── 1. Input取得 & バリデーション ──
const input = await Actor.getInput<ActorInput>();

if (!input?.aspId || !input?.loginUrl || !input?.loginId || !input?.loginPassword) {
  throw new Error('必須パラメータ不足: aspId, loginUrl, loginId, loginPassword');
}
if (!input.steps || input.steps.length === 0) {
  throw new Error('steps が空です。最低1つの操作ステップが必要です。');
}

const {
  aspId,
  aspName = aspId,
  loginUrl,
  loginId,
  loginPassword,
  steps,
  encoding = 'utf-8',
  timeout = 60000,
} = input;

log.info(`========================================`);
log.info(`ASP: ${aspName} (${aspId})`);
log.info(`Steps: ${steps.length}個`);
log.info(`Encoding: ${encoding}`);
log.info(`========================================`);

const kvStore = await Actor.openKeyValueStore();

// ── 2. ブラウザ起動 ──
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
context.setDefaultTimeout(timeout);
const page = await context.newPage();

// ステップ実行コンテキスト
const ctx: StepContext = {
  page,
  kvStore,
  encoding,
  timeout,
  aspId,
  files: [],
  screenshotKeys: [],
};

try {
  // ── 3. ログイン ──
  log.info(`ログインページへ遷移: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle', timeout });

  // ログインフォームの自動検出 & 入力
  log.info('ログインフォーム入力中...');

  // ID入力（よくあるセレクタを順番に試す）
  const idSelectors = [
    'input[name="userId"]',
    'input[name="username"]',
    'input[name="login_id"]',
    'input[name="email"]',
    'input[name="user_id"]',
    'input[type="email"]',
    '#userId', '#username', '#email', '#login_id',
    'input[type="text"]:first-of-type',
  ];

  const pwSelectors = [
    'input[name="password"]',
    'input[name="passwd"]',
    'input[name="pass"]',
    'input[type="password"]',
    '#password', '#passwd',
  ];

  const submitSelectors = [
    'input[type="submit"]',
    'button[type="submit"]',
    'input[name="login"]',
    'input[name="submit"]',
    '.login-btn', '#login-btn', '.btn-login',
    'button:has-text("ログイン")',
    'button:has-text("Login")',
  ];

  await fillFirst(page, idSelectors, loginId, 'ログインID');
  await fillFirst(page, pwSelectors, loginPassword, 'パスワード');

  // ログイン前スクリーンショット
  await kvStore.setValue(
    `screenshot_${aspId}_pre-login`,
    await page.screenshot({ fullPage: true }),
    { contentType: 'image/png' }
  );

  await clickFirst(page, submitSelectors, 'ログインボタン');
  await page.waitForLoadState('networkidle', { timeout: 30000 });

  const postLoginUrl = page.url();
  log.info(`ログイン後URL: ${postLoginUrl}`);

  // ログイン後スクリーンショット
  await kvStore.setValue(
    `screenshot_${aspId}_post-login`,
    await page.screenshot({ fullPage: true }),
    { contentType: 'image/png' }
  );
  ctx.screenshotKeys.push(`screenshot_${aspId}_post-login`);

  // ログイン成功判定（簡易: URLにloginが含まれていたら警告）
  if (postLoginUrl.includes('login') || postLoginUrl.includes('signin')) {
    log.warning('ログイン後もログインページに留まっている可能性あり');
    // エラーメッセージがあるか確認
    const errorText = await page
      .locator('.error, .alert-danger, .alert-error, [role="alert"], .login-error')
      .first()
      .textContent({ timeout: 3000 })
      .catch(() => null);

    if (errorText) {
      throw new Error(`ログイン失敗: ${errorText.trim()}`);
    }
  }

  log.info('ログイン成功（推定）');

  // ── 4. ステップ実行 ──
  await executeSteps(ctx, steps);

  // ── 5. 結果出力 ──
  const output: ActorOutput = {
    aspId,
    aspName,
    status: 'SUCCESS',
    files: ctx.files,
    executedAt: new Date().toISOString(),
    screenshotKeys: ctx.screenshotKeys,
  };

  await Actor.pushData(output);

  log.info(`========================================`);
  log.info(`完了: ${ctx.files.length} ファイルダウンロード成功`);
  ctx.files.forEach((f) => log.info(`  - ${f.fileName} (${f.sizeBytes} bytes)`));
  log.info(`========================================`);

} catch (error: any) {
  log.error(`致命的エラー: ${error.message}`);

  // エラー時スクリーンショット
  try {
    await kvStore.setValue(
      `screenshot_${aspId}_fatal-error`,
      await page.screenshot({ fullPage: true }),
      { contentType: 'image/png' }
    );
  } catch { /* ignore */ }

  const output: ActorOutput = {
    aspId,
    aspName,
    status: 'FAILED',
    files: ctx.files,
    error: error.message,
    executedAt: new Date().toISOString(),
    screenshotKeys: ctx.screenshotKeys,
  };

  await Actor.pushData(output);

} finally {
  await browser.close();
  log.info('ブラウザ終了');
}

await Actor.exit();


// ── ヘルパー関数 ──

/**
 * 複数のセレクタ候補から最初にマッチしたものにfillする
 */
async function fillFirst(
  page: any,
  selectors: string[],
  value: string,
  label: string,
): Promise<void> {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 2000 });
      if (el) {
        await page.fill(sel, value);
        log.info(`  ${label}: ${sel} にマッチ`);
        return;
      }
    } catch { /* 次を試す */ }
  }
  throw new Error(`${label} の入力欄が見つかりません (試行: ${selectors.length}個)`);
}

/**
 * 複数のセレクタ候補から最初にマッチしたものをクリックする
 */
async function clickFirst(
  page: any,
  selectors: string[],
  label: string,
): Promise<void> {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 2000 });
      if (el) {
        await page.click(sel);
        log.info(`  ${label}: ${sel} にマッチ`);
        return;
      }
    } catch { /* 次を試す */ }
  }
  throw new Error(`${label} が見つかりません (試行: ${selectors.length}個)`);
}
