'use client';

/**
 * C6 · 五模块信号矩阵（visualization PRD §5.1，方向 A 图形化，D2 决策）。
 * 每行独立展示模块 assessment + confidence + 一句话 —— V2：维度独立，
 * 不合成总分。底部汇总分歧度（信息本身，非评分）。
 */

import type { SectionType } from '@bourse/shared-types';

const SECTION_LABELS: Record<string, string> = {
  COMPANY_QUALITY: '公司质量',
  INDUSTRY_POSITION: '行业与竞争',
  VALUATION_SCENARIOS: '估值与情景',
  RISK_REGISTER: '风险清单',
  MARKET_SIGNALS: '市场信号',
};

const ASSESSMENT_TONE: Record<string, string> = {
  STRONG: 'var(--color-signal-bullish)',
  LEADING: 'var(--color-signal-bullish)',
  POSITIVE: 'var(--color-signal-bullish)',
  FAIR: 'var(--color-fg-2)',
  NEUTRAL: 'var(--color-fg-2)',
  COMPETITIVE: 'var(--color-fg-2)',
  MIXED: 'var(--color-warn)',
  MEDIUM: 'var(--color-warn)',
  WEAK: 'var(--color-signal-bearish)',
  CHALLENGED: 'var(--color-signal-bearish)',
  NEGATIVE: 'var(--color-signal-bearish)',
  OVERVALUED: 'var(--color-warn)',
  UNDERVALUED: 'var(--color-signal-bullish)',
  UNASSESSABLE: 'var(--color-fg-3)',
};

const ASSESSMENT_TEXT: Record<string, string> = {
  STRONG: '强', LEADING: '领先', POSITIVE: '偏多', FAIR: '合理', NEUTRAL: '中性',
  COMPETITIVE: '有竞争力', MIXED: '混合', MEDIUM: '中等', WEAK: '弱',
  CHALLENGED: '承压', NEGATIVE: '偏空', OVERVALUED: '偏贵', UNDERVALUED: '偏低',
  UNASSESSABLE: '无法评估', LOW: '低风险', HIGH: '高风险',
};

export interface SignalMatrixRow {
  type: SectionType;
  assessment?: string;
  confidence?: string;
  summary?: string;
  status?: string;
  coverage?: {
    status?: string;
    confidenceCap?: string;
    missingCriticalFacts?: string[];
    blockedClaims?: string[];
  };
}

function ConfidenceBar({ confidence, coverage }: { confidence?: string; coverage?: SignalMatrixRow['coverage'] }) {
  const filled = confidence === 'HIGH' ? 3 : confidence === 'MEDIUM' ? 2 : confidence === 'LOW' ? 1 : 0;
  const color =
    confidence === 'HIGH' ? 'var(--color-signal-bullish)'
    : confidence === 'MEDIUM' ? 'var(--color-warn)'
    : 'var(--color-signal-bearish)';
  return (
    <span
      className="inline-flex gap-[3px]"
      aria-label={`置信 ${confidence ?? '—'}`}
      title={coverage?.confidenceCap && coverage.confidenceCap !== confidence
        ? `数据覆盖度封顶为${coverage.confidenceCap}：${coverage.missingCriticalFacts?.join('、') || coverage.status || '来源质量受限'}`
        : undefined}
    >
      {[1, 2, 3].map((i) => (
        <i
          key={i}
          className="block h-[5px] w-[14px] rounded-[2px]"
          style={{ background: i <= filled ? color : 'var(--color-border)' }}
        />
      ))}
    </span>
  );
}

export function SignalMatrix({
  rows,
  onJump,
}: {
  rows: SignalMatrixRow[];
  /** V4 出口：点击行滚动到对应 section。 */
  onJump?: (type: SectionType) => void;
}) {
  if (rows.length === 0) return null;
  const assessed = rows.filter(
    (r) => r.assessment && r.assessment !== 'UNASSESSABLE' && r.status !== 'SKIPPED',
  );
  const bullish = assessed.filter((r) =>
    ['STRONG', 'LEADING', 'POSITIVE', 'UNDERVALUED'].includes(r.assessment!),
  ).length;
  const bearish = assessed.filter((r) =>
    ['WEAK', 'CHALLENGED', 'NEGATIVE', 'OVERVALUED'].includes(r.assessment!),
  ).length;
  const neutral = assessed.length - bullish - bearish;

  return (
    <div>
      <div className="space-y-1.5">
        {rows.map((row) => {
          const tone = ASSESSMENT_TONE[row.assessment ?? ''] ?? 'var(--color-fg-3)';
          const pending = !row.assessment;
          return (
            <button
              key={row.type}
              type="button"
              onClick={() => onJump?.(row.type)}
              className="flex w-full items-center gap-2.5 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-elev-2)] px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]"
              aria-label={`${SECTION_LABELS[row.type] ?? row.type}：${ASSESSMENT_TEXT[row.assessment ?? ''] ?? '待完成'}`}
            >
              <span
                aria-hidden
                className="h-[8px] w-[8px] shrink-0 rounded-full"
                style={{ background: pending ? 'var(--color-border)' : tone }}
              />
              <span className="w-[92px] shrink-0 text-[12.5px] font-medium">
                {SECTION_LABELS[row.type] ?? row.type}
              </span>
              <span
                className="shrink-0 rounded-[5px] px-1.5 py-px text-[11px] font-semibold"
                style={{ color: tone, background: 'color-mix(in srgb, currentColor 12%, transparent)' }}
              >
                {pending ? '…' : ASSESSMENT_TEXT[row.assessment!] ?? row.assessment}
              </span>
              <ConfidenceBar confidence={row.confidence} coverage={row.coverage} />
              <span className="m-0 hidden truncate text-[12px] text-[var(--color-fg-2)] sm:block">
                {row.summary ?? (row.assessment === 'UNASSESSABLE'
                  ? `无法评估：${row.coverage?.missingCriticalFacts?.join('、') || '缺少满足最低证据要求的事实'}`
                  : '')}
              </span>
            </button>
          );
        })}
      </div>
      <p className="m-0 mt-2.5 text-[11.5px] text-[var(--color-fg-3)]">
        分歧度：偏正向 {bullish} · 中性 {neutral} · 偏谨慎 {bearish}
        {bullish + bearish + neutral < rows.length ? ' · 其余待完成' : ''}
        <span className="ml-1">（维度独立展示，不合成总分）</span>
      </p>
    </div>
  );
}
