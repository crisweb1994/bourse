'use client';

import { Card, Pill, SectionTag } from '@/components/ui';
import { CONFIDENCE_LABELS, SIGNAL_LABELS } from '@/lib/constants';

export function ConclusionBanner({
  signal,
  confidence,
  headline,
  dataAsOf,
}: {
  signal?: string | null;
  confidence?: string | null;
  headline?: string | null;
  dataAsOf?: string | null;
}) {
  const variant = signal === 'POSITIVE' ? 'emerald' : signal === 'CAUTIOUS' ? 'danger' : 'neutral';
  return (
    <Card>
      <div className="px-6 py-5 sm:px-7 sm:py-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <SectionTag>综合结论</SectionTag>
          {signal ? <Pill variant={variant}>{SIGNAL_LABELS[signal] ?? signal}</Pill> : <Pill variant="warn">信息不足，暂不形成方向性判断</Pill>}
          {confidence && <span className="text-[11px] text-[var(--color-fg-3)]">置信度 {CONFIDENCE_LABELS[confidence] ?? confidence}</span>}
        </div>
        {headline ? <p className="mt-4 m-0 max-w-[70ch] text-[17px] leading-[1.6] text-[var(--color-fg)]">{headline}</p> : <p className="mt-4 m-0 text-[13px] text-[var(--color-fg-2)]">综合结论正在生成…</p>}
        {dataAsOf && <p className="mt-4 m-0 font-mono text-[11px] text-[var(--color-fg-3)]">数据截至 {dataAsOf}</p>}
      </div>
    </Card>
  );
}
