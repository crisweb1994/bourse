'use client';

import { SectionTag } from '@/components/ui';
import { ASSESSMENT_LABELS, CONFIDENCE_LABELS } from '@/lib/constants';
import { cn } from '@/lib/utils';

export function StructuredCard({ sectionType, data, className }: { sectionType: string; data: any; className?: string }) {
  if (!data || typeof data !== 'object') return null;
  const findings = Array.isArray(data.findings) ? data.findings : [];
  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {data.assessment && <span className="rounded-[var(--radius-btn)] border border-[var(--color-border)] px-2.5 py-1 text-[12px] font-medium">{ASSESSMENT_LABELS[data.assessment] ?? data.assessment}</span>}
        {data.confidence && <span className="text-[11px] text-[var(--color-fg-3)]">置信度 {CONFIDENCE_LABELS[data.confidence] ?? data.confidence}</span>}
      </div>
      {data.summary && <Box title="模块摘要"><p className="m-0 text-[13.5px] leading-[1.7]">{data.summary}</p></Box>}
      {sectionType === 'VALUATION_SCENARIOS' && Array.isArray(data.scenarios) && data.scenarios.length > 0 && <ScenarioList scenarios={data.scenarios} />}
      {sectionType === 'RISK_REGISTER' && Array.isArray(data.risks) && data.risks.length > 0 && <RiskList risks={data.risks} />}
      {findings.length > 0 && (
        <div className="space-y-3">
          {findings.map((finding: any, index: number) => (
            <Box key={`${finding.title ?? 'finding'}-${index}`} title={finding.title ?? `重点发现 ${index + 1}`} dataFinding>
              <p className="m-0 text-[13.5px] leading-[1.7]">{finding.conclusion ?? '—'}</p>
              {Array.isArray(finding.caveats) && finding.caveats.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px] text-[var(--color-fg-2)]">{finding.caveats.map((item: string, i: number) => <li key={i}>{item}</li>)}</ul>}
              <EvidenceList evidence={finding.evidence} />
            </Box>
          ))}
        </div>
      )}
      {Array.isArray(data.limitations) && data.limitations.length > 0 && <Box title="限制与缺口"><ul className="m-0 list-disc space-y-1 pl-5 text-[12.5px] leading-[1.6] text-[var(--color-fg-2)]">{data.limitations.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul></Box>}
      {data.disclaimer && <p className="m-0 text-[11px] text-[var(--color-fg-3)]">{data.disclaimer}</p>}
    </div>
  );
}

function Box({ title, children, dataFinding }: { title: string; children: React.ReactNode; dataFinding?: boolean }) {
  return <div {...(dataFinding ? { 'data-finding': 'true' } : {})} className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg)]"><div className="border-b border-[var(--color-border-soft)] px-4 py-2.5"><SectionTag>{title}</SectionTag></div><div className="px-4 py-3">{children}</div></div>;
}

function EvidenceList({ evidence }: { evidence: unknown }) {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  return <div className="mt-3 space-y-2 border-t border-[var(--color-border-soft)] pt-2.5">{evidence.map((item: any, index: number) => <div key={index}><p className="m-0 text-[11.5px] text-[var(--color-fg-2)]">证据：{item.claim ?? '—'}</p>{Array.isArray(item.citations) && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{item.citations.map((citation: any, i: number) => <a key={i} href={citation.url} target="_blank" rel="noreferrer" className="max-w-full truncate text-[11px] text-[var(--color-accent-600)] hover:underline">{citation.title ?? citation.url}</a>)}</div>}</div>)}</div>;
}

function ScenarioList({ scenarios }: { scenarios: any[] }) {
  return <Box title="情景区间"><div className="grid gap-2 sm:grid-cols-3">{scenarios.map((scenario, index) => <div key={`${scenario.case}-${index}`} className="rounded-[6px] border border-[var(--color-border-soft)] px-3 py-2.5"><div className="text-[12px] font-medium">{scenario.case === 'BEAR' ? '悲观' : scenario.case === 'BULL' ? '乐观' : '基准'}</div><div className="mt-1 font-mono text-[13px]">{scenario.valueRange ? `${scenario.valueRange.low}–${scenario.valueRange.high} ${scenario.valueRange.currency}` : '无法计算'}</div>{Array.isArray(scenario.assumptions) && <p className="mt-1.5 m-0 text-[11.5px] leading-[1.5] text-[var(--color-fg-2)]">{scenario.assumptions.join('；')}</p>}</div>)}</div></Box>;
}

function RiskList({ risks }: { risks: any[] }) {
  return <Box title="重点风险"><div className="space-y-3">{risks.map((risk, index) => <div key={`${risk.title}-${index}`} className="border-b border-[var(--color-border-soft)] pb-3 last:border-b-0 last:pb-0"><div className="flex flex-wrap items-center gap-2"><span className="text-[13px] font-medium">{risk.title}</span><span className="text-[11px] text-[var(--color-fg-3)]">可能性 {risk.likelihood ?? '—'} · 影响 {risk.impact ?? '—'}</span></div><p className="mt-1 m-0 text-[12.5px] leading-[1.6] text-[var(--color-fg-2)]">{risk.mechanism ?? '—'}</p>{Array.isArray(risk.indicators) && risk.indicators.length > 0 && <p className="mt-1 m-0 text-[11.5px] text-[var(--color-fg-3)]">监测：{risk.indicators.join('、')}</p>}</div>)}</div></Box>;
}
