'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ChevronLeft, ChevronRight, Loader2, Search, Trash2 } from 'lucide-react';
import type { AnalysisMode, AnalysisStatus } from '@bourse/shared-types';
import { getAnalysisHistory, deleteAnalysis, type AnalysisHistoryItemDto } from '@/lib/api';
import { CONFIDENCE_LABELS, FOCUS_WINDOW_LABELS, MODE_LABELS, SIGNAL_LABELS, STATUS_LABELS } from '@/lib/constants';
import { stockHref } from '@/lib/stock-href';
import { statusPillVariant, signalPillVariant } from '@/lib/pills';
import { Button, Card, Input, InputShell, PageHeader, Pill, Select, SelectOption, Sym, Table, TBody, TFoot, THead, toast, useConfirm } from '@/components/ui';

const MODE_OPTIONS = [
  { value: '', label: '全部模式' },
  { value: 'QUICK', label: MODE_LABELS.QUICK },
  { value: 'DEEP', label: MODE_LABELS.DEEP },
] as const;

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'COMPLETED', label: STATUS_LABELS.COMPLETED },
  { value: 'PARTIAL_FAILED', label: STATUS_LABELS.PARTIAL_FAILED },
  { value: 'IN_PROGRESS', label: STATUS_LABELS.IN_PROGRESS },
  { value: 'PENDING', label: STATUS_LABELS.PENDING },
  { value: 'FAILED', label: STATUS_LABELS.FAILED },
  { value: 'CANCELLED', label: STATUS_LABELS.CANCELLED },
] as const;

export default function HistoryPage() {
  const confirm = useConfirm();
  const [items, setItems] = useState<AnalysisHistoryItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [mode, setMode] = useState<AnalysisMode | ''>('');
  const [status, setStatus] = useState<AnalysisStatus | ''>('');
  const [symbol, setSymbol] = useState('');
  const limit = 15;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAnalysisHistory(page, limit, {
        ...(mode ? { mode } : {}),
        ...(status ? { status } : {}),
        ...(symbol.trim() ? { symbol: symbol.trim() } : {}),
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取历史失败');
    } finally {
      setLoading(false);
    }
  }, [page, mode, status, symbol]);

  useEffect(() => { void fetchHistory(); }, [fetchHistory]);
  useEffect(() => { setPage(1); }, [mode, status, symbol]);

  const handleDelete = async (id: string) => {
    const ok = await confirm({ title: '删除研究记录？', description: '关联的模块结果和证据快照会一并删除，且无法恢复。', confirmText: '删除', cancelText: '取消', danger: true });
    if (!ok) return;
    setDeleting(id);
    try { await deleteAnalysis(id); toast.success('已删除'); await fetchHistory(); }
    catch (error) { toast.error(error instanceof Error ? error.message : '删除失败'); }
    finally { setDeleting(null); }
  };

  return <>
    <PageHeader tag="研究历史" title="研究历史" subtitle="查看、回放或删除已经生成的研究报告。" />
    <section className="mb-6"><div className="grid grid-cols-1 items-center gap-2.5 md:grid-cols-[1fr_auto_auto_auto]">
      <InputShell sans leading={<Search />}><Input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="按股票代码筛选…" /></InputShell>
      <Select value={mode || '__all'} onValueChange={(value) => setMode(value === '__all' ? '' : value as AnalysisMode)} sans className="min-w-[140px]"><SelectOption value="__all">{MODE_OPTIONS[0].label}</SelectOption>{MODE_OPTIONS.slice(1).map((option) => <SelectOption key={option.value} value={option.value}>{option.label}</SelectOption>)}</Select>
      <Select value={status || '__all'} onValueChange={(value) => setStatus(value === '__all' ? '' : value as AnalysisStatus)} sans className="min-w-[140px]"><SelectOption value="__all">全部状态</SelectOption>{STATUS_OPTIONS.slice(1).map((option) => <SelectOption key={option.value} value={option.value}>{option.label}</SelectOption>)}</Select>
      <span className="px-2 font-mono text-[11.5px] text-[var(--color-fg-3)]">共 {total} 条</span>
    </div></section>
    <Card>
      {loading ? <div className="grid place-items-center py-14"><Loader2 className="h-4 w-4 animate-spin text-[var(--color-fg-3)]" strokeWidth={1.5} /></div> : items.length === 0 ? <div className="py-14 text-center text-[13px] text-[var(--color-fg-3)]">没有符合条件的研究记录。</div> : <>
        <Table><THead><tr><th>代码</th><th>名称</th><th>模式 / 时间</th><th>状态</th><th>结论</th><th>模型</th><th>日期</th><th /></tr></THead><TBody>{items.map((item) => {
          const signalVariant = signalPillVariant(item.overallSignal);
          return <tr key={item.id}>
            <td><Sym>{item.symbol}</Sym></td><td className="max-w-[180px] truncate">{item.stock.name}</td>
            <td><Pill variant="flat">{MODE_LABELS[item.mode]} · {FOCUS_WINDOW_LABELS[item.focusWindow]}</Pill></td>
            <td><Pill variant={statusPillVariant(item.status)} dot>{STATUS_LABELS[item.status] ?? item.status}</Pill></td>
            <td>{signalVariant ? <Pill variant={signalVariant}>{SIGNAL_LABELS[item.overallSignal!] ?? item.overallSignal} · {item.overallConfidence ? CONFIDENCE_LABELS[item.overallConfidence] : ''}</Pill> : <span className="text-[var(--color-fg-3)]">信息不足</span>}</td>
            <td><span className="font-mono text-[12px] text-[var(--color-fg-2)]">{item.aiModel ?? item.aiProvider ?? '—'}</span></td>
            <td><span className="font-mono text-[12px] text-[var(--color-fg-3)]">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span></td>
            <td><div className="flex justify-end gap-1.5"><Link href={stockHref(item.stock, { analysisId: item.id })}><Button size="icon" aria-label="打开研究"><ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.5} /></Button></Link><Button size="icon" aria-label="删除研究" onClick={() => void handleDelete(item.id)} disabled={deleting === item.id}>{deleting === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} /> : <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />}</Button></div></td>
          </tr>;
        })}</TBody></Table>
        <TFoot><span className="font-mono">第 {page} / {totalPages} 页 · 共 {total} 条</span><div className="flex gap-1.5"><Button size="icon" aria-label="上一页" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}><ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} /></Button><Button size="icon" aria-label="下一页" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}><ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} /></Button></div></TFoot>
      </>}
    </Card>
  </>;
}
