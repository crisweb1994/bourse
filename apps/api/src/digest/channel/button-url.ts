/**
 * IM 按钮跳转 URL 构造（PRD DB.6 / DB.7）。
 *
 * Telegram / 飞书 inline button 的 url 字段要求**绝对且可达的 URL**——Telegram
 * 明确拒绝 localhost / 无效 host（返回 400 "Wrong HTTP URL"）。所以 FRONTEND_URL
 * 未配或为 localhost（dev）时返回 null，adapter 据此**不发按钮**（纯文本简报，
 * AI 解读内容不受影响）；生产配了公网域名才带按钮。
 */
const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const IS_PUBLIC = /^(https?:\/\/)(?!localhost|127\.0\.0\.1)/i.test(FRONTEND_URL);

/**
 * 复研按钮 URL。null = 不可发按钮（dev / 未配 FRONTEND_URL），adapter 应跳过按钮。
 * 生产配了公网域名时返回 `${FRONTEND_URL}/stock/:symbol?reanalyze=1`。
 */
export function reanalyzeUrl(symbol: string): string | null {
  if (!IS_PUBLIC) return null;
  return `${FRONTEND_URL}/stock/${encodeURIComponent(symbol)}?reanalyze=1`;
}
