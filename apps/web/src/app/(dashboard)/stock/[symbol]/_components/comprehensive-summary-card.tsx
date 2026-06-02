'use client';

import { Card, SectionTag } from '@/components/ui';

// ============================================================
// ComprehensiveSummaryCard
// ============================================================

export function ComprehensiveSummaryCard({ data }: { data: any }) {
  return (
    <div className="space-y-3">
      {data.bullCase?.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b border-[var(--color-border-soft)]">
            <SectionTag>看多理由</SectionTag>
          </div>
          <ul className="px-4 py-3 m-0 list-none space-y-1.5 text-[13.5px]">
            {data.bullCase.map((c: string, i: number) => (
              <li key={i} className="flex gap-2">
                <span className="text-[var(--color-accent-600)]">+</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.bearCase?.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b border-[var(--color-border-soft)]">
            <SectionTag>看空理由</SectionTag>
          </div>
          <ul className="px-4 py-3 m-0 list-none space-y-1.5 text-[13.5px]">
            {data.bearCase.map((c: string, i: number) => (
              <li key={i} className="flex gap-2">
                <span className="text-[var(--color-warn)]">−</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.biggestRisk && (
        <Card>
          <div className="px-4 py-3 border-b border-[var(--color-border-soft)]">
            <SectionTag>最大风险</SectionTag>
          </div>
          <p className="px-4 py-3 m-0 text-[13.5px]">{data.biggestRisk}</p>
        </Card>
      )}

      {data.valuationConclusion && (
        <Card>
          <div className="px-4 py-3 border-b border-[var(--color-border-soft)]">
            <SectionTag>估值结论</SectionTag>
          </div>
          <p className="px-4 py-3 m-0 text-[13.5px]">
            {data.valuationConclusion}
          </p>
        </Card>
      )}

      {data.suitableInvestorType && (
        <Card>
          <div className="px-4 py-3 border-b border-[var(--color-border-soft)]">
            <SectionTag>适合投资者</SectionTag>
          </div>
          <div className="px-4 py-3">
            <p className="m-0 text-[13.5px]">{data.suitableInvestorType}</p>
            {data.watchlistWorthy != null && (
              <p className="mt-1 m-0 text-[12px] text-[var(--color-fg-2)]">
                {data.watchlistWorthy
                  ? '值得加入自选观察'
                  : '暂不建议加入自选'}
              </p>
            )}
          </div>
        </Card>
      )}

      {data.disclaimer && (
        <p className="text-[11px] text-[var(--color-fg-3)] m-0">
          {data.disclaimer}
        </p>
      )}
    </div>
  );
}
