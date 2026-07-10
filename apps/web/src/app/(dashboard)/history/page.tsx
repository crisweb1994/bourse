'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Loader2,
  Trash2,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Search,
} from 'lucide-react';
import {
  getAnalysisHistory,
  deleteAnalysis,
  type AnalysisHistoryItemDto,
} from '@/lib/api';
import {
  ACTIVE_ANALYSIS_TYPES,
  ANALYSIS_TYPE_LABELS,
  LEGACY_ANALYSIS_TYPES,
  PROVIDER_LABELS,
  SIGNAL_LABELS_BILINGUAL,
  STATUS_LABELS,
} from '@/lib/constants';
import { stockHref } from '@/lib/stock-href';
import { statusPillVariant, signalPillVariant } from '@/lib/pills';
import type { AnalysisStatus, AnalysisType } from '@bourse/shared-types';
import {
  Button,
  Card,
  Input,
  InputShell,
  PageHeader,
  Pill,
  Select,
  SelectOption,
  Sym,
  Table,
  THead,
  TBody,
  TFoot,
  toast,
  useConfirm,
} from '@/components/ui';

const ANALYSIS_TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  ...ACTIVE_ANALYSIS_TYPES.map((value) => ({
    value,
    label: ANALYSIS_TYPE_LABELS[value],
  })),
  ...LEGACY_ANALYSIS_TYPES.map((value) => ({
    value,
    label: ANALYSIS_TYPE_LABELS[value],
  })),
];

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'PARTIAL_FAILED', label: '部分失败' },
  { value: 'BUDGET_EXHAUSTED', label: '预算耗尽' },
  { value: 'IN_PROGRESS', label: '分析中' },
  { value: 'PENDING', label: '等待中' },
  { value: 'FAILED', label: '失败' },
  { value: 'CANCELLED', label: '已取消' },
];


export default function HistoryPage() {
  const confirm = useConfirm();
  const [items, setItems] = useState<AnalysisHistoryItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [analysisType, setAnalysisType] = useState<AnalysisType | ''>('');
  const [status, setStatus] = useState<AnalysisStatus | ''>('');
  const [symbol, setSymbol] = useState('');
  const [degradedOnly, setDegradedOnly] = useState(false);

  const limit = 15;
  const totalPages = Math.ceil(total / limit);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const filters: {
        analysisType?: AnalysisType;
        status?: AnalysisStatus;
        symbol?: string;
        degradedOnly?: boolean;
      } = {};
      if (analysisType) filters.analysisType = analysisType;
      if (status) filters.status = status;
      if (symbol.trim()) filters.symbol = symbol.trim();
      if (degradedOnly) filters.degradedOnly = true;
      const data = await getAnalysisHistory(page, limit, filters);
      setItems(data.items);
      setTotal(data.total);
    } catch {} finally {
      setLoading(false);
    }
  }, [page, analysisType, status, symbol, degradedOnly]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    setPage(1);
  }, [analysisType, status, symbol, degradedOnly]);

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: '删除分析记录？',
      description: '该操作不可撤销 — 关联的引用、结构化结论与遥测数据都将一并清除。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    setDeleting(id);
    try {
      await deleteAnalysis(id);
      toast.success('已删除');
      fetchHistory();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <PageHeader
        tag="历史记录"
        title="分析历史"
        subtitle="每次分析都会以结构化 JSON、引用与遥测信息持久化，可从本列表回看与重放。可按代码、类型、状态筛选。"
      />

      {/* Filter row */}
      <section className="mb-6">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-2.5 items-center">
          <InputShell
            sans
            leading={<Search />}
          >
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="按股票代码筛选…"
            />
          </InputShell>
          <Select
            value={analysisType || '__all'}
            onValueChange={(v) =>
              setAnalysisType(v === '__all' ? '' : (v as AnalysisType))
            }
            sans
            className="min-w-[140px]"
          >
            <SelectOption value="__all">全部类型</SelectOption>
            {ANALYSIS_TYPE_OPTIONS.filter((o) => o.value).map((o) => (
              <SelectOption key={o.value} value={o.value}>
                {o.label}
              </SelectOption>
            ))}
          </Select>
          <Select
            value={status || '__all'}
            onValueChange={(v) =>
              setStatus(v === '__all' ? '' : (v as AnalysisStatus))
            }
            sans
            className="min-w-[140px]"
          >
            <SelectOption value="__all">全部状态</SelectOption>
            {STATUS_OPTIONS.filter((o) => o.value).map((o) => (
              <SelectOption key={o.value} value={o.value}>
                {o.label}
              </SelectOption>
            ))}
          </Select>
          <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg-2)] cursor-pointer select-none px-1">
            <input
              type="checkbox"
              checked={degradedOnly}
              onChange={(e) => setDegradedOnly(e.target.checked)}
              className="accent-[var(--color-fg)]"
            />
            仅看 ⚠ 降级
          </label>
          <span className="font-mono text-[11.5px] text-[var(--color-fg-3)] tracking-[0.04em] px-2">
            共 {total} 条
          </span>
        </div>
      </section>

      {/* Table */}
      <Card>
        {loading ? (
          <div className="py-14 grid place-items-center">
            <Loader2
              className="w-4 h-4 animate-spin text-[var(--color-fg-3)]"
              strokeWidth={1.5}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="py-14 text-center text-[13px] text-[var(--color-fg-3)]">
            没有符合筛选条件的记录。
          </div>
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>信号</th>
                  <th>模型</th>
                  <th>日期</th>
                  <th style={{ textAlign: 'right' }}></th>
                </tr>
              </THead>
              <TBody>
                {items.map((item) => {
                  const sig = signalPillVariant(item.overallSignal);
                  return (
                    <tr key={item.id}>
                      <td>
                        <Sym>{item.symbol}</Sym>
                      </td>
                      <td className="max-w-[180px] truncate">
                        {item.stock.name}
                      </td>
                      <td>
                        <div className="inline-flex items-center gap-1">
                          <Pill variant="flat">
                            <span className="font-mono">
                              {ANALYSIS_TYPE_LABELS[item.analysisType] ||
                                item.analysisType}
                            </span>
                          </Pill>
                          {item.degradedSource === 'WEB_SEARCH_FALLBACK' && (
                            <span
                              title="数据源降级 · 使用了 web_search 兜底"
                              className="text-[var(--color-warn)] text-[11px]"
                            >
                              ⚠
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <Pill variant={statusPillVariant(item.status)} dot>
                          {STATUS_LABELS[item.status] || item.status}
                        </Pill>
                      </td>
                      <td>
                        {sig ? (
                          <Pill variant={sig}>
                            {SIGNAL_LABELS_BILINGUAL[item.overallSignal!] ||
                              item.overallSignal}
                          </Pill>
                        ) : (
                          <span className="text-[var(--color-fg-3)]">—</span>
                        )}
                      </td>
                      <td>
                        <span className="font-mono text-[12px] text-[var(--color-fg-2)]">
                          {PROVIDER_LABELS[item.aiProvider || ''] ||
                            item.aiProvider ||
                            '—'}
                        </span>
                      </td>
                      <td>
                        <span className="font-mono text-[12px] text-[var(--color-fg-3)]">
                          {new Date(item.createdAt).toLocaleDateString('zh-CN')}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div className="flex justify-end gap-1.5">
                          <Link href={stockHref(item.stock, { analysisId: item.id })}>
                            <Button size="icon" aria-label="Open">
                              <ArrowUpRight
                                className="w-3.5 h-3.5"
                                strokeWidth={1.5}
                              />
                            </Button>
                          </Link>
                          <Button
                            size="icon"
                            onClick={() => handleDelete(item.id)}
                            disabled={deleting === item.id}
                            aria-label="Delete"
                          >
                            {deleting === item.id ? (
                              <Loader2
                                className="w-3.5 h-3.5 animate-spin"
                                strokeWidth={1.5}
                              />
                            ) : (
                              <Trash2
                                className="w-3.5 h-3.5"
                                strokeWidth={1.5}
                              />
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </TBody>
            </Table>
            <TFoot>
              <span className="font-mono">
                第 {page} / {totalPages || 1} 页 · 共 {total} 条
              </span>
              <div className="flex gap-1.5">
                <Button
                  size="icon"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  aria-label="Previous"
                >
                  <ChevronLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
                </Button>
                <Button
                  size="icon"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  aria-label="Next"
                >
                  <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.5} />
                </Button>
              </div>
            </TFoot>
          </>
        )}
      </Card>
    </>
  );
}
