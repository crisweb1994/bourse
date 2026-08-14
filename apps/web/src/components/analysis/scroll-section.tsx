'use client';

import { Clock, Loader2, MessageSquareText, RotateCcw, XCircle } from 'lucide-react';
import type { SectionData } from '@/hooks/use-analysis-stream';
import { MarkdownRenderer } from '@/components/shared/markdown-renderer';
import { Button, Card, Pill, SectionTag } from '@/components/ui';
import { SECTION_LABELS, ASSESSMENT_LABELS } from '@/lib/constants';
import { StructuredCard } from './structured-card';
import { CitationList } from './citation-list';

interface Props {
  section: SectionData;
  onRetry?: () => void;
  showCitations?: boolean;
  onAsk?: (sectionType: string) => void;
}

export function ScrollSection({ section, onRetry, showCitations = true, onAsk }: Props) {
  const label = SECTION_LABELS[section.type] ?? section.type;
  const assessment = section.structuredJson?.assessment as string | undefined;
  return (
    <section id={`section-${section.type}`} className="scroll-mt-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-soft)] px-5 py-3">
          <SectionTag>{label}</SectionTag>
          {section.status === 'streaming' && <span className="flex items-center gap-1 font-mono text-[10.5px] text-[var(--color-fg-3)]"><span className="stream-dot" />研究中</span>}
          {section.status === 'failed' && <Pill variant="danger">失败</Pill>}
          {section.status === 'skipped' && <Pill variant="warn">已跳过</Pill>}
          {section.status === 'cancelled' && <Pill variant="neutral">已取消</Pill>}
          {assessment && <Pill variant="flat">{ASSESSMENT_LABELS[assessment] ?? assessment}</Pill>}
          {onAsk && section.status === 'completed' && (
            <Button size="sm" className="ml-auto" onClick={() => onAsk(section.type)}>
              <MessageSquareText className="h-3 w-3" strokeWidth={1.5} />询问此模块
            </Button>
          )}
        </div>

        <div className="px-6 py-5">
          {section.status === 'skipped' && (
            <div className="rounded-[8px] border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] p-3 text-[13px] leading-[1.65]">
              <div className="mb-1 font-medium">本模块未运行</div>
              <div className="text-[12px] text-[var(--color-fg-2)]">{section.skipReason || '缺少必要输入，暂时无法安全生成结论。'}</div>
              {section.skipMissingFields?.length ? <div className="mt-1 font-mono text-[11px] text-[var(--color-fg-3)]">缺少：{section.skipMissingFields.join('、')}</div> : null}
            </div>
          )}
          {section.status === 'cancelled' && <p className="m-0 text-[13px] text-[var(--color-fg-2)]">本次研究已取消，已生成的其他模块仍然保留。</p>}
          {section.status === 'failed' && (
            <div className="mb-4 space-y-2 rounded-[8px] border border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] p-3 text-[13px] text-[var(--color-danger)]">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 font-medium"><XCircle className="h-3.5 w-3.5" strokeWidth={1.5} />该模块研究失败</span>
                {onRetry && <Button size="sm" onClick={onRetry}><RotateCcw className="h-3 w-3" strokeWidth={1.5} />重试失败部分</Button>}
              </div>
              {section.errorMessage && <p className="m-0 text-[12px] text-[var(--color-fg-2)]">{section.errorMessage}</p>}
            </div>
          )}

          {section.markdown ? <MarkdownRenderer content={section.markdown} /> : section.status === 'streaming' ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg-2)]"><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />正在研究{label}…</div>
          ) : section.status === 'pending' ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg-2)]"><Clock className="h-3.5 w-3.5" strokeWidth={1.5} />等待开始…</div>
          ) : section.status === 'failed' ? <p className="m-0 text-[13px] text-[var(--color-fg-2)]">暂未生成内容。</p> : null}

          {section.status === 'streaming' && section.markdown && <div className="mt-4 flex items-center gap-2 font-mono text-[11.5px] text-[var(--color-fg-3)]"><span className="stream-dot" />生成中…</div>}

          {(section.structuredJson || (showCitations && section.citations.length > 0)) && (
            <div className="mt-6 space-y-4">
              {section.structuredJson && <StructuredCard sectionType={section.type} data={section.structuredJson} />}
              {showCitations && section.citations.length > 0 && <CitationList citations={section.citations} />}
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
