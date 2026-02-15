/**
 * 汎用Actor 型定義
 */

// ── Input Schema ──

export interface ActorInput {
  aspId: string;
  aspName?: string;
  loginUrl: string;
  loginId: string;
  loginPassword: string;
  steps: Step[];
  encoding?: string;   // デフォルト: 'utf-8'
  timeout?: number;     // デフォルト: 60000
}

// ── Step定義 ──
// スプシのsteps_jsonに書く操作ステップ

export type Step =
  | GotoStep
  | ClickStep
  | FillStep
  | SelectStep
  | WaitStep
  | DownloadClickStep
  | ScreenshotStep;

export interface GotoStep {
  action: 'goto';
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface ClickStep {
  action: 'click';
  selector: string;
  waitAfter?: number;           // クリック後の待機ms
  waitForNavigation?: boolean;  // ページ遷移を待つか
}

export interface FillStep {
  action: 'fill';
  selector: string;
  value: string;       // 動的プレースホルダ対応: {{lastMonthStart}} 等
}

export interface SelectStep {
  action: 'select';
  selector: string;
  value: string;
}

export interface WaitStep {
  action: 'wait';
  ms?: number;
  selector?: string;   // 要素の出現を待つ場合
}

export interface DownloadClickStep {
  action: 'downloadClick';
  selector: string;
  fileName?: string;   // 保存時のファイル名（省略時はサーバ提案名）
}

export interface ScreenshotStep {
  action: 'screenshot';
  label?: string;
}

// ── Output ──

export interface ActorOutput {
  aspId: string;
  aspName: string;
  status: 'SUCCESS' | 'FAILED';
  files: DownloadedFile[];
  error?: string;
  executedAt: string;
  screenshotKeys: string[];
}

export interface DownloadedFile {
  fileName: string;
  kvStoreKey: string;
  sizeBytes: number;
}
