'use client';

import { Loader2, XCircle, RotateCcw, Clock } from 'lucide-react';
import type { SectionData } from '@/hooks/use-analysis-stream';
import { MarkdownRenderer } from '@/components/shared/markdown-renderer';
import { Button, Card, Pill, SectionTag } from '@/components/ui';
import { SignalBadge } from './signal-badge';
import { StructuredCard } from './structured-card';
import { CitationList } from './citation-list';
import { ANALYSIS_TYPE_LABELS as SECTION_LABELS } from '@/lib/constants';

interface Props {
  section: SectionData;
  onRetry: (sectionId: string) => void;
  showSideContent?: boolean;
  showCitations?: boolean;
}

export function ScrollSection({
  section,
  onRetry,
  showSideContent = true,
  showCitations = showSideContent,
}: Props) {
  const label = SECTION_LABELS[section.type] || section.type;
  // PR-9: surface the structured signal in the section header (Style A mockup
  // puts "基本面 看多·高" on the title line). Falls back to status pill if
  // structuredJson has not arrived yet.
  const conclusion = section.structuredJson?.conclusion as
    | { signal?: string; confidence?: string }
    | undefined;
  const hasSignal = section.status === 'completed' && !!conclusion?.signal;

  return (
    <section id={`section-${section.type}`} className="scroll-mt-4">
      <Card>
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-5 py-3">
          <SectionTag>{label}</SectionTag>
          {section.status === 'streaming' && (
            <span className="flex items-center gap-1 font-mono text-[10.5px] text-[var(--color-fg-3)] uppercase tracking-[0.04em]">
              <span className="stream-dot" />
              生成中
            </span>
          )}
          {section.status === 'failed' && <Pill variant="danger">失败</Pill>}
          {section.status === 'skipped' && (
            <Pill variant="warn">已跳过</Pill>
          )}
          {hasSignal && (
            <SignalBadge
              signal={conclusion!.signal!}
              confidence={conclusion!.confidence}
              className="ml-auto"
            />
          )}
        </div>

        <div className="px-6 py-5">
          {section.status === 'skipped' && (
            <div className="rounded-[8px] border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] p-3 text-[13px] leading-[1.65]">
              <div className="font-medium mb-1">本维度已主动跳过</div>
              <div className="text-[var(--color-fg-2)] text-[12px]">
                数据源降级 · 该维度依赖的私有数据
                {section.skipMissingFields &&
                section.skipMissingFields.length > 0 ? (
                  <span className="font-mono mx-1">
                    ({section.skipMissingFields.join(', ')})
                  </span>
                ) : null}
                无法通过 web_search 重建，已跳过以避免误导性结论。
              </div>
            </div>
          )}

          {/* Failure */}
          {section.status === 'failed' && (
            <div className="mb-4 space-y-2 rounded-[8px] border border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] p-3 text-[13px] text-[var(--color-danger)]">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 font-medium">
                  <XCircle className="w-3.5 h-3.5" strokeWidth={1.5} />
                  该维度分析失败
                  {section.markdown && (
                    <span className="text-[11.5px] font-normal text-[var(--color-fg-2)]">
                      （以下为已生成的部分内容）
                    </span>
                  )}
                </span>
                {section.id && (
                  <Button size="sm" onClick={() => onRetry(section.id!)}>
                    <RotateCcw className="w-3 h-3" strokeWidth={1.5} />
                    重试
                  </Button>
                )}
              </div>
              {section.errorMessage && (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-[6px] bg-[var(--color-bg)] border border-[var(--color-border)] p-2 text-[11.5px] leading-[1.55] text-[var(--color-fg)] font-mono">
                  {section.errorMessage}
                </pre>
              )}
            </div>
          )}

          {/* Markdown body */}
          {section.markdown ? (
            <MarkdownRenderer content={section.markdown} />
          ) : section.status === 'streaming' ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg-2)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
              AI 正在搜索和分析 {label}…
            </div>
          ) : section.status === 'pending' ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg-2)]">
              <Clock className="w-3.5 h-3.5" strokeWidth={1.5} />
              等待开始…
            </div>
          ) : section.status === 'failed' ? (
            <p className="text-[13px] text-[var(--color-fg-2)] m-0">
              AI 未生成任何内容
            </p>
          ) : null}

          {section.status === 'streaming' && section.markdown && (
            <div className="mt-4 flex items-center gap-2 text-[11.5px] text-[var(--color-fg-3)] font-mono uppercase tracking-[0.04em]">
              <span className="stream-dot" />
              生成中…
            </div>
          )}

          {/* Inline structured + citations */}
          {(showSideContent || showCitations) &&
            (section.structuredJson || section.citations.length > 0) && (
              <div className="mt-6 space-y-4">
                {showSideContent && section.structuredJson && (
                  <StructuredCard
                    sectionType={section.type}
                    data={section.structuredJson}
                  />
                )}
                {showCitations && section.citations.length > 0 && (
                  <CitationList citations={section.citations} />
                )}
              </div>
            )}
        </div>
      </Card>
    </section>
  );
}
