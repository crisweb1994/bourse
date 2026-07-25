'use client';

import { useState } from 'react';
import { Building2, ChevronDown, ExternalLink, Loader2, MessageSquareText, RotateCcw } from 'lucide-react';
import type { InvestorRelationsActivityType, InvestorRelationsEventDto, InvestorRelationsGenerationRunDto, InvestorRelationsTimelineResponseDto } from '@bourse/shared-types';
import { Button, Pill } from '@/components/ui';

export function InvestorRelationsTimeline({ response, generation, loading, error, onRetry, onAsk }: {
  response: InvestorRelationsTimelineResponseDto | null;
  generation: InvestorRelationsGenerationRunDto | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onAsk: (event: InvestorRelationsEventDto) => void;
}) {
  if (response && !response.supported) return null;
  const running = generation && ['QUEUED', 'RUNNING'].includes(generation.status);
  const failed = generation?.status === 'FAILED';
  const failureMessage = error ?? (failed ? generationError(generation) : null);
  if (!response?.events.length && !running && !failureMessage) return null;
  return (
    <section className="mb-8" aria-labelledby="ir-timeline-title">
      <div className="mb-3 flex items-end justify-between gap-4 border-b border-[var(--color-border)] pb-2.5">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[10.5px] text-[var(--color-fg-3)]"><Building2 className="h-3.5 w-3.5" strokeWidth={1.5} />管理层沟通</div>
          <h2 id="ir-timeline-title" className="m-0 text-[16px] font-semibold text-[var(--color-fg)]">投关动态</h2>
        </div>
        {response?.events.length ? <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">最近 {response.events.length} 场</span> : null}
      </div>
      {running && <div className="mb-3 flex items-center gap-2 border-b border-[var(--color-border-soft)] py-3 text-[12px] text-[var(--color-fg-2)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在整理最新投关记录 · {stageLabel(generation.stage)}</div>}
      {failureMessage && <div className="mb-3 flex items-center justify-between gap-3 border-b border-[var(--color-danger-line)] py-3 text-[12px] text-[var(--color-danger)]"><span>{failureMessage}</span>{(!generation || generation.retryable) && <Button size="sm" variant="danger" onClick={onRetry}><RotateCcw className="h-3.5 w-3.5" />重试</Button>}</div>}
      <div className="relative before:absolute before:bottom-4 before:left-[7px] before:top-4 before:w-px before:bg-[var(--color-border)]">
        {response?.events.map((event) => <TimelineEvent key={event.revisionId} event={event} onAsk={() => onAsk(event)} />)}
      </div>
      {loading && !running ? <div className="py-3 text-[11px] text-[var(--color-fg-3)]">正在刷新投关时间线…</div> : null}
    </section>
  );
}

function TimelineEvent({ event, onAsk }: { event: InvestorRelationsEventDto; onAsk: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = `ir-event-${event.id}`;
  const toggleExpanded = () => setExpanded((value) => !value);
  return (
    <article className="relative grid grid-cols-[16px_minmax(0,1fr)] gap-3 py-3.5">
      <span className="relative z-10 mt-1 h-[15px] w-[15px] rounded-full border border-[var(--color-border-strong)] bg-[var(--color-bg)]" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <time className="font-mono text-[11px] text-[var(--color-fg-3)]">{event.occurredAt}</time>
          <Pill variant="neutral">{activityLabel(event.activityType)}</Pill>
          {event.revisionStatus === 'PARTIAL' && <Pill variant="warn">部分内容</Pill>}
        </div>
        <h3 className="m-0 mt-1.5 text-[13px] font-medium leading-5 text-[var(--color-fg)]">{event.title}</h3>
        {event.topics.length > 0 && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-fg-2)]">{event.topics.slice(0, 3).map((topic) => <span key={topic.id}>{topic.title}</span>)}</div>}
        <div className="mt-2.5 border-t border-[var(--color-border-soft)] pt-2">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-[var(--color-fg-3)] hover:text-[var(--color-fg)]"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggleExpanded}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              toggleExpanded();
            }}
          >
            {expanded ? '收起记录' : '展开记录'}
            <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          {expanded ? <div id={contentId} className="mt-3 space-y-3">
            {event.managementClaims.map((claim) => (
              <blockquote key={claim.id} className="m-0 border-l-2 border-[var(--color-border-strong)] pl-3 text-[12px] leading-5 text-[var(--color-fg-2)]">
                {claim.text}
                <div className="mt-1 text-[10.5px] text-[var(--color-fg-3)]">原文{claim.source.page ? ` · 第 ${claim.source.page} 页` : ''}</div>
              </blockquote>
            ))}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" onClick={onAsk}><MessageSquareText className="h-3.5 w-3.5" />追问这次调研</Button>
              <Button size="sm" variant="quiet" onClick={() => window.open(event.filing.sourceUrl, '_blank', 'noopener,noreferrer')}><ExternalLink className="h-3.5 w-3.5" />公告原文</Button>
            </div>
          </div> : null}
        </div>
      </div>
    </article>
  );
}

function activityLabel(type: InvestorRelationsActivityType) {
  const labels: Record<InvestorRelationsActivityType, string> = { INSTITUTIONAL_RESEARCH: '机构调研', EARNINGS_BRIEFING: '业绩说明会', ANALYST_MEETING: '分析师会议', ROADSHOW: '路演', PHONE_CALL: '电话交流', SITE_VISIT: '现场参观', OTHER: '投关活动' };
  return labels[type];
}
function stageLabel(stage: string) { return ({ DISCOVER: '查找公告', FETCH: '读取原文', DERIVE: '解析文档', EXTRACT: '提取主题', CHECK: '核对引用', PERSIST: '生成时间线' } as Record<string, string>)[stage] ?? '处理中'; }
function generationError(run: InvestorRelationsGenerationRunDto) {
  if (run.errorCode === 'CHECK_REJECTED_ALL') return '未找到可被原文引用支持的管理层说法';
  if (run.errorCode === 'ACTIVITY_DATE_UNRESOLVED') return '无法从公告中确认活动日期';
  return '投关记录整理失败';
}
