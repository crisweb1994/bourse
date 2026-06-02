'use client';

import { Card } from '@/components/ui';
import {
  ANALYSIS_TYPE_LABELS as SECTION_LABELS,
  SIGNAL_LABELS,
  CONFIDENCE_LABELS,
} from '@/lib/constants';
import { cn } from '@/lib/utils';

const SIGNAL_DOT: Record<string, string> = {
  BULLISH: 'bg-[var(--color-signal-bullish)]',
  NEUTRAL: 'bg-[var(--color-fg-4)]',
  BEARISH: 'bg-[var(--color-signal-bearish)]',
};
const SIGNAL_TEXT: Record<string, string> = {
  BULLISH: 'text-[var(--color-signal-bullish)]',
  NEUTRAL: 'text-[var(--color-fg-3)]',
  BEARISH: 'text-[var(--color-signal-bearish)]',
};

interface SectionSignal {
  type: string;
  signal: string;
  confidence: string;
  oneLiner?: string;
}

interface SummaryJson {
  overallSignal: string;
  overallConfidence: string;
  oneLiner?: string;
  sectionSignals?: SectionSignal[];
  biggestRisk?: string;
  watchlistWorthy?: boolean;
  dataAsOf?: string;
}

interface Props {
  summaryJson?: SummaryJson | null;
}

export function RightInsightsPanel({ summaryJson }: Props) {
  if (!summaryJson) return null;
  const sectionSignals = summaryJson.sectionSignals ?? [];
  const biggestRisk = summaryJson.biggestRisk?.trim();
  if (sectionSignals.length === 0 && !biggestRisk) return null;

  const body = (
    <>
      {sectionSignals.length > 0 && (
        <SectionSignalsCard signals={sectionSignals} />
      )}
      {biggestRisk && <BiggestRiskCallout text={biggestRisk} />}
    </>
  );

  return (
    <>
      {/* lg+ sticky rail */}
      <aside className="sticky top-2 hidden space-y-3 self-start lg:block">
        {body}
      </aside>

      {/* < lg collapsible disclosure */}
      <details
        className={
          'group block lg:hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg-elev)]'
        }
      >
        <summary
          className={
            'flex cursor-pointer items-center justify-between gap-3 px-4 py-3 ' +
            'text-[13px] font-medium text-[var(--color-fg)] [&::-webkit-details-marker]:hidden'
          }
        >
          <span>各维度信号 · 最大风险</span>
          <span className="font-mono text-[11px] text-[var(--color-fg-3)] group-open:rotate-180 transition-transform">
            ▾
          </span>
        </summary>
        <div className="space-y-3 border-t border-[var(--color-border-soft)] px-4 py-3">
          {body}
        </div>
      </details>
    </>
  );
}

function SectionSignalsCard({ signals }: { signals: SectionSignal[] }) {
  return (
    <Card>
      <div className="px-4 py-3 border-b border-[var(--color-border-soft)]">
        <span className="text-[12px] text-[var(--color-fg-3)]">各维度信号</span>
      </div>
      <ul className="m-0 list-none px-4 py-1">
        {signals.map((s) => {
          const conf = CONFIDENCE_LABELS[s.confidence];
          const sigLabel = SIGNAL_LABELS[s.signal] || s.signal;
          return (
            <li
              key={s.type}
              className="flex items-start gap-2.5 border-b border-[var(--color-border-soft)] py-2.5 last:border-b-0"
            >
              <span
                className={cn(
                  'mt-[7px] h-2 w-2 shrink-0 rounded-full',
                  SIGNAL_DOT[s.signal] || SIGNAL_DOT.NEUTRAL,
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-[var(--color-fg)]">
                    {SECTION_LABELS[s.type] || s.type}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-[11px]',
                      SIGNAL_TEXT[s.signal] || SIGNAL_TEXT.NEUTRAL,
                    )}
                  >
                    {sigLabel}
                    {conf ? `·${conf}` : ''}
                  </span>
                </div>
                {s.oneLiner && (
                  <p className="mt-0.5 m-0 text-[11.5px] leading-[1.5] text-[var(--color-fg-2)]">
                    {s.oneLiner}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function BiggestRiskCallout({ text }: { text: string }) {
  return (
    <div
      className={
        'rounded-[var(--radius-card)] border border-[var(--color-warn-line)] ' +
        'bg-[var(--color-warn-soft)] px-4 py-3'
      }
    >
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--color-warn)]">
        最大风险
      </div>
      <p className="m-0 text-[12.5px] leading-[1.6] text-[var(--color-fg)]">
        {text}
      </p>
    </div>
  );
}
