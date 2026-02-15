/**
 * 動的値リゾルバ
 *
 * steps内の value や url に含まれるプレースホルダを実際の値に変換する。
 *
 * 対応プレースホルダ:
 *   {{lastMonthStart}}  → 先月1日 (YYYY-MM-DD)
 *   {{lastMonthEnd}}    → 先月末日 (YYYY-MM-DD)
 *   {{thisMonthStart}}  → 今月1日
 *   {{today}}           → 今日
 *   {{year}}            → 今年 (YYYY)
 *   {{month}}           → 今月 (MM)
 *   {{lastMonth}}       → 先月 (MM)
 *   {{YYYYMMDD}}        → 今日 (YYYYMMDD形式)
 */

export function resolveValue(value: string): string {
  if (!value || typeof value !== 'string') return value;

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed

  const replacements: Record<string, string> = {
    '{{lastMonthStart}}': formatDate(new Date(y, m - 1, 1)),
    '{{lastMonthEnd}}': formatDate(new Date(y, m, 0)),
    '{{thisMonthStart}}': formatDate(new Date(y, m, 1)),
    '{{today}}': formatDate(now),
    '{{year}}': String(y),
    '{{month}}': pad2(m + 1),
    '{{lastMonth}}': pad2(m === 0 ? 12 : m),
    '{{YYYYMMDD}}': `${y}${pad2(m + 1)}${pad2(now.getDate())}`,
  };

  let result = value;
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, replacement);
  }
  return result;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
