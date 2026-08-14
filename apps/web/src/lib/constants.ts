import {
  ANALYSIS_MODES,
  FOCUS_WINDOWS,
  SECTION_LABELS,
  SECTION_TYPES,
  type AnalysisMode,
  type FocusWindow,
  type SectionType,
} from '@bourse/shared-types';

export { SECTION_LABELS, SECTION_TYPES } from '@bourse/shared-types';

export const ANALYSIS_MODE_OPTIONS: Array<{ value: AnalysisMode; label: string; description: string }> = [
  { value: 'QUICK', label: '快速扫描', description: '先看最重要的事实和风险' },
  { value: 'DEEP', label: '深度研究', description: '更完整的证据和情景分析' },
];

export const FOCUS_WINDOW_OPTIONS: Array<{ value: FocusWindow; label: string }> = [
  { value: '30D', label: '最近 30 天' },
  { value: '90D', label: '最近 90 天' },
  { value: '1Y', label: '最近 1 年' },
  { value: '3Y', label: '最近 3 年' },
];

export const MODE_LABELS: Record<AnalysisMode, string> = {
  QUICK: '快速扫描',
  DEEP: '深度研究',
};

export const FOCUS_WINDOW_LABELS: Record<FocusWindow, string> = {
  '30D': '30 天',
  '90D': '90 天',
  '1Y': '1 年',
  '3Y': '3 年',
};

export const STATUS_LABELS: Record<string, string> = {
  PENDING: '等待中',
  IN_PROGRESS: '研究中',
  COMPLETED: '已完成',
  PARTIAL_FAILED: '部分完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  SKIPPED: '已跳过',
};

export const MARKET_LABELS: Record<string, string> = {
  US: '美股',
  HK: '港股',
  CN: 'A 股',
};

export const PROVIDER_LABELS: Record<string, string> = {
  default: '系统默认',
  claude: 'Claude',
  openai: 'OpenAI',
};

export const SIGNAL_LABELS: Record<string, string> = {
  POSITIVE: '偏积极',
  NEUTRAL: '中性',
  CAUTIOUS: '偏谨慎',
};

export const SIGNAL_LABELS_BILINGUAL = SIGNAL_LABELS;

export const CONFIDENCE_LABELS: Record<string, string> = {
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
};

export const ASSESSMENT_LABELS: Record<string, string> = {
  STRONG: '较强',
  MIXED: '一般',
  WEAK: '较弱',
  LEADING: '领先',
  COMPETITIVE: '有竞争力',
  CHALLENGED: '承压',
  UNDERVALUED: '低估',
  FAIR: '合理',
  OVERVALUED: '高估',
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  POSITIVE: '积极',
  NEUTRAL: '中性',
  NEGATIVE: '消极',
  UNASSESSABLE: '无法评估',
};

export function sectionLabel(type: SectionType | string): string {
  return SECTION_LABELS[type as SectionType] ?? type;
}

export { ANALYSIS_MODES, FOCUS_WINDOWS };
