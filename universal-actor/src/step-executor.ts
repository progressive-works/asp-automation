/**
 * ステップ実行エンジン
 *
 * steps配列を順番に処理する。
 * 各ステップの action に応じて Playwright の操作を実行。
 */
import { Page } from 'playwright';
import { log } from 'apify';
import { readFileSync } from 'fs';
import iconv from 'iconv-lite';
import type { Step, DownloadedFile } from './types.js';
import { resolveValue } from './resolver.js';

export interface StepContext {
  page: Page;
  kvStore: any;          // Apify KeyValueStore
  encoding: string;
  timeout: number;
  aspId: string;
  files: DownloadedFile[];
  screenshotKeys: string[];
}

/**
 * 全ステップを順次実行する
 */
export async function executeSteps(ctx: StepContext, steps: Step[]): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepLabel = `Step ${i + 1}/${steps.length} [${step.action}]`;

    log.info(`[${ctx.aspId}] ${stepLabel} 実行中...`);

    try {
      await executeStep(ctx, step);
      log.info(`[${ctx.aspId}] ${stepLabel} 完了`);
    } catch (error: any) {
      log.error(`[${ctx.aspId}] ${stepLabel} 失敗: ${error.message}`);
      // エラー時スクリーンショット
      await saveScreenshot(ctx, `error-step-${i + 1}`);
      throw error;
    }
  }
}

/**
 * 個別ステップの実行
 */
async function executeStep(ctx: StepContext, step: Step): Promise<void> {
  const { page, timeout } = ctx;

  switch (step.action) {
    // ── ページ遷移 ──
    case 'goto': {
      const url = resolveValue(step.url);
      log.info(`  → goto: ${url}`);
      await page.goto(url, {
        waitUntil: step.waitUntil || 'networkidle',
        timeout,
      });
      break;
    }

    // ── クリック ──
    case 'click': {
      log.info(`  → click: ${step.selector}`);
      await page.waitForSelector(step.selector, { timeout: 10000 });

      if (step.waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout }).catch(() => {
            log.warning('  Navigation待ちタイムアウト（SPA or Ajax）');
          }),
          page.click(step.selector),
        ]);
      } else {
        await page.click(step.selector);
      }

      if (step.waitAfter) {
        await page.waitForTimeout(step.waitAfter);
      }
      break;
    }

    // ── テキスト入力 ──
    case 'fill': {
      const value = resolveValue(step.value);
      log.info(`  → fill: ${step.selector} = "${value}"`);
      await page.waitForSelector(step.selector, { timeout: 10000 });
      // 既存の値をクリアしてから入力
      await page.fill(step.selector, '');
      await page.fill(step.selector, value);
      break;
    }

    // ── セレクトボックス選択 ──
    case 'select': {
      const value = resolveValue(step.value);
      log.info(`  → select: ${step.selector} = "${value}"`);
      await page.waitForSelector(step.selector, { timeout: 10000 });
      await page.selectOption(step.selector, value);
      break;
    }

    // ── 待機 ──
    case 'wait': {
      if (step.selector) {
        log.info(`  → wait for: ${step.selector}`);
        await page.waitForSelector(step.selector, { timeout: timeout });
      } else {
        const ms = step.ms || 2000;
        log.info(`  → wait: ${ms}ms`);
        await page.waitForTimeout(ms);
      }
      break;
    }

    // ── ダウンロード（クリック起動型）──
    case 'downloadClick': {
      log.info(`  → downloadClick: ${step.selector}`);
      await page.waitForSelector(step.selector, { timeout: 10000 });

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.click(step.selector),
      ]);

      const suggestedName = download.suggestedFilename();
      const filePath = await download.path();

      if (!filePath) {
        throw new Error('ダウンロードファイルのパス取得失敗');
      }

      // ファイル読み込み（エンコーディング変換対応）
      const rawBuffer = readFileSync(filePath);
      let content: string;

      if (ctx.encoding.toLowerCase() !== 'utf-8' && ctx.encoding.toLowerCase() !== 'utf8') {
        content = iconv.decode(rawBuffer, ctx.encoding);
        log.info(`  エンコーディング変換: ${ctx.encoding} → UTF-8`);
      } else {
        content = rawBuffer.toString('utf-8');
      }

      // Key-Value Storeに保存
      const fileName = step.fileName
        ? resolveValue(step.fileName)
        : suggestedName;
      const kvKey = `csv_${ctx.aspId}_${Date.now()}`;

      await ctx.kvStore.setValue(kvKey, content, {
        contentType: 'text/csv; charset=utf-8',
      });

      ctx.files.push({
        fileName,
        kvStoreKey: kvKey,
        sizeBytes: rawBuffer.length,
      });

      log.info(`  保存完了: ${fileName} (${rawBuffer.length} bytes) → ${kvKey}`);
      break;
    }

    // ── スクリーンショット ──
    case 'screenshot': {
      const label = step.label || `step-screenshot`;
      await saveScreenshot(ctx, label);
      break;
    }

    default:
      log.warning(`  未対応のaction: ${(step as any).action}（スキップ）`);
  }
}

/**
 * スクリーンショット保存ヘルパー
 */
async function saveScreenshot(ctx: StepContext, label: string): Promise<void> {
  try {
    const key = `screenshot_${ctx.aspId}_${label}`;
    const buffer = await ctx.page.screenshot({ fullPage: true });
    await ctx.kvStore.setValue(key, buffer, { contentType: 'image/png' });
    ctx.screenshotKeys.push(key);
    log.info(`  スクリーンショット保存: ${key}`);
  } catch (e: any) {
    log.warning(`  スクリーンショット保存失敗: ${e.message}`);
  }
}
