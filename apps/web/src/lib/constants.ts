export const ANALYSIS_TYPE_LABELS: Record<string, string> = {
  FUNDAMENTAL: '基本面',
  VALUATION: '估值',
  INDUSTRY: '行业竞争',
  RISK: '风险',
  TECHNICAL: '技术面',
  SENTIMENT: '情绪',
  SCENARIO: '情景',
  PORTFOLIO: '组合适配',
  GOVERNANCE: '公司治理',
  COMPREHENSIVE: '综合分析',
  DEBATE: 'AI 多空合议',
};

export const STATUS_LABELS: Record<string, string> = {
  PENDING: '等待中',
  IN_PROGRESS: '分析中',
  COMPLETED: '已完成',
  PARTIAL_FAILED: '部分失败',
  FAILED: '失败',
  CANCELLED: '已取消',
};

export const MARKET_LABELS: Record<string, string> = {
  US: '美股',
  HK: '港股',
  CN: 'A股',
  JP: '日股',
  UK: '英股',
};

export const PROVIDER_LABELS: Record<string, string> = {
  default: '系统默认',
  claude: 'Claude',
  openai: 'OpenAI',
};

/**
 * Bilingual signal labels (英文 · 中文) — for tables, pills and verdict cards.
 */
export const SIGNAL_LABELS_BILINGUAL: Record<string, string> = {
  BULLISH: 'BULLISH · 看多',
  NEUTRAL: 'NEUTRAL · 中性',
  BEARISH: 'BEARISH · 看空',
};

/** Short signal / confidence labels (中文) — verdict cards, badges, digests. */
export const SIGNAL_LABELS: Record<string, string> = {
  BULLISH: '看多',
  NEUTRAL: '中性',
  BEARISH: '看空',
};

export const CONFIDENCE_LABELS: Record<string, string> = {
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
};
