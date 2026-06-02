'use client';

/**
 * PR-9 · Conclusion banner, Style A hero treatment.
 *
 * Single canonical surface for "what does this analysis conclude".
 * Visual language (per mockup A):
 *  - section tag (mono, mini)
 *  - signal pill + "置信度 ·" caption + 3-pip confidence bar
 *  - 17px display body for the one-liner (max-width to keep line measure)
 *  - mono datestamp at the bottom
 *  - no shadow, no gradient — just card chrome
 */
import { Card, SectionTag } from '@/components/ui';
import { SignalBadge } from './signal-badge';
import { cn } from '@/lib/utils';

const ANALYSIS_LABELS: Record<string, string> = {
  FUNDAMENTAL: '基本面分析',
  VALUATION: '估值分析',
  INDUSTRY: '行业竞争分析',
  RISK: '风险分析',
  TECHNICAL: '技术面分析',
  SENTIMENT: '情绪分析',
  SCENARIO: '情景分析',
  PORTFOLIO: '组合适配分析',
  GOVERNANCE: '公司治理分析',
  COMPREHENSIVE: '综合分析',
};

const PIP_COUNT: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export function ConclusionBanner({
  signal,
  confidence,
  oneLiner,
  dataAsOf,
  analysisType,
}: {
  signal?: string | null;
  confidence?: string | null;
  oneLiner?: string | null;
  dataAsOf?: string | null;
  analysisType: string;
}) {
  const pips = confidence ? PIP_COUNT[confidence] ?? 0 : 0;
  const bullish = signal === 'BULLISH';
  return (
    <Card>
      <div className="px-6 py-5 sm:px-7 sm:py-6">
        <div className="flex flex-wrap items-center gap-3">
          <SectionTag>
            {ANALYSIS_LABELS[analysisType] || analysisType}
          </SectionTag>
          {signal && (
            <SignalBadge signal={signal} confidence={confidence || undefined} />
          )}
          {confidence && pips > 0 && (
            <ConfidencePips count={pips} bullish={bullish} />
          )}
        </div>
        {oneLiner && (
          <p
            className={cn(
              'mt-4 m-0 max-w-[64ch] text-[17px] leading-[1.6]',
              'text-[var(--color-fg)]',
            )}
          >
            {oneLiner}
          </p>
        )}
        {dataAsOf && (
          <p
            className={cn(
              'mt-4 m-0 font-mono text-[11px] uppercase tracking-[0.06em]',
              'text-[var(--color-fg-3)]',
            )}
          >
            数据截至 {dataAsOf}
          </p>
        )}
      </div>
    </Card>
  );
}

function ConfidencePips({
  count,
  bullish,
}: {
  count: number;
  bullish: boolean;
}) {
  const onColor = bullish
    ? 'bg-[var(--color-accent)]'
    : 'bg-[var(--color-fg-2)]';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--color-fg-3)]">
        置信度
      </span>
      <span className="inline-flex items-center gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              'h-[5px] w-[14px] rounded-[2px]',
              i < count ? onColor : 'bg-[var(--color-border)]',
            )}
          />
        ))}
      </span>
    </span>
  );
}
