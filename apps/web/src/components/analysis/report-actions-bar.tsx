'use client';

import { useMemo, useState } from 'react';
import {
  Copy,
  Download,
  RefreshCcw,
  Star,
  Check,
  GitCompare,
  Printer,
} from 'lucide-react';
import type { SectionData } from '@/hooks/use-analysis-stream';
import { Button, SectionTag, toast } from '@/components/ui';
import {
  ANALYSIS_TYPE_LABELS as SECTION_LABEL,
  SIGNAL_LABELS,
  CONFIDENCE_LABELS,
} from '@/lib/constants';
import { cn } from '@/lib/utils';

interface SectionsForExport {
  sections: SectionData[];
  summaryMarkdown: string;
  symbol: string;
  market: string;
  generatedAt?: string | null;
  signal?: string | null;
  confidence?: string | null;
}

export interface ReportActionsBarProps extends SectionsForExport {
  /** Show "加入自选" action when the stock is not yet on watchlist. */
  showAddToWatchlist: boolean;
  watchlistBusy: boolean;
  onAddToWatchlist?: () => void;
  /** Same-type re-run handler. Caller already has stockId + selectedType. */
  onRerun?: () => void;
  /** "对比上次" — only enabled when a previous comparable analysis exists. */
  onCompareWithLast?: () => void;
  /** True while the comparison Dialog is mounted (visual press-state). */
  comparing?: boolean;
}

export function ReportActionsBar({
  sections,
  summaryMarkdown,
  symbol,
  market,
  generatedAt,
  signal,
  confidence,
  showAddToWatchlist,
  watchlistBusy,
  onAddToWatchlist,
  onRerun,
  onCompareWithLast,
  comparing,
}: ReportActionsBarProps) {
  const [copied, setCopied] = useState(false);

  const fullMarkdown = useMemo(
    () => buildFullMarkdown({ sections, summaryMarkdown, symbol, market, generatedAt, signal, confidence }),
    [sections, summaryMarkdown, symbol, market, generatedAt, signal, confidence],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('复制失败，请手动选择文本');
    }
  };

  const handleExport = () => {
    const blob = new Blob([fullMarkdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const tag = generatedAt
      ? new Date(generatedAt).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    a.download = `${symbol}-${tag}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    // S4+ · PDF export. Uses the browser's native print → save-as-PDF;
    // @media print CSS hides chrome (see globals.css `@media print`).
    document.body.classList.add('print-mode');
    window.setTimeout(() => {
      window.print();
      window.setTimeout(
        () => document.body.classList.remove('print-mode'),
        500,
      );
    }, 50);
  };

  return (
    <div
      data-actions-bar
      className={
        'mt-6 flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] ' +
        'border border-[var(--color-border)] bg-[var(--color-bg-elev)] ' +
        'px-4 py-3'
      }
    >
      <SectionTag>分析操作</SectionTag>
      <span className="flex-1" />

      <Button size="sm" onClick={handleCopy}>
        {copied ? (
          <Check className="h-3 w-3" strokeWidth={1.5} />
        ) : (
          <Copy className="h-3 w-3" strokeWidth={1.5} />
        )}
        {copied ? '已复制' : '复制 markdown'}
      </Button>

      <Button size="sm" onClick={handleExport}>
        <Download className="h-3 w-3" strokeWidth={1.5} />
        导出 .md
      </Button>

      <Button size="sm" onClick={handlePrint}>
        <Printer className="h-3 w-3" strokeWidth={1.5} />
        导出 PDF
      </Button>

      {onCompareWithLast && (
        <Button
          size="sm"
          onClick={onCompareWithLast}
          disabled={comparing}
          className={cn(comparing && 'opacity-60')}
        >
          <GitCompare className="h-3 w-3" strokeWidth={1.5} />
          对比上次
        </Button>
      )}

      {onRerun && (
        <Button size="sm" onClick={onRerun}>
          <RefreshCcw className="h-3 w-3" strokeWidth={1.5} />
          再跑一次
        </Button>
      )}

      {showAddToWatchlist && onAddToWatchlist && (
        <Button
          size="sm"
          onClick={onAddToWatchlist}
          disabled={watchlistBusy}
        >
          <Star className="h-3 w-3" strokeWidth={1.5} />
          加入自选
        </Button>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Markdown builder — single source of truth for copy / export.
// ----------------------------------------------------------------------------
function buildFullMarkdown(p: SectionsForExport): string {
  const head: string[] = [];
  head.push(`# ${p.symbol} · ${p.market} 综合分析`);
  if (p.generatedAt) head.push(`> 生成时间：${p.generatedAt}`);
  if (p.signal) {
    head.push(
      `> 结论：${labelSignal(p.signal)}${p.confidence ? ' · 置信度 ' + labelConf(p.confidence) : ''}`,
    );
  }
  head.push('');

  const dimBlocks: string[] = [];
  for (const s of p.sections) {
    if (s.status !== 'completed' || !s.markdown) continue;
    dimBlocks.push(`## ${SECTION_LABEL[s.type] ?? s.type}`);
    dimBlocks.push('');
    dimBlocks.push(s.markdown.trim());
    dimBlocks.push('');
    if (s.citations.length > 0) {
      dimBlocks.push('### 参考资料');
      s.citations.forEach((c, i) => {
        dimBlocks.push(`${i + 1}. [${c.title || c.url}](${c.url})`);
      });
      dimBlocks.push('');
    }
  }

  const summary = p.summaryMarkdown?.trim()
    ? ['## 综合总览', '', p.summaryMarkdown.trim(), '']
    : [];

  return [...head, ...dimBlocks, ...summary].join('\n');
}

function labelSignal(s: string): string {
  return SIGNAL_LABELS[s] ?? s;
}
function labelConf(c: string): string {
  return CONFIDENCE_LABELS[c] ?? c;
}
