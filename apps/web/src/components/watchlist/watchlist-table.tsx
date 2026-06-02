'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Trash2,
  Loader2,
  StickyNote,
  Check,
  X,
  ArrowUpRight,
} from 'lucide-react';
import type { WatchlistItemDto } from '@bourse/shared-types';
import { removeFromWatchlist, updateWatchlistItem } from '@/lib/api';
import { MARKET_LABELS } from '@/lib/constants';
import { stockHref } from '@/lib/stock-href';
import {
  Button,
  Card,
  Pill,
  Sym,
  TBody,
  TFoot,
  THead,
  Table,
  toast,
  useConfirm,
} from '@/components/ui';
import { cn } from '@/lib/utils';

export function WatchlistTable({
  items,
  onChanged,
}: {
  items: WatchlistItemDto[];
  onChanged: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [notesValue, setNotesValue] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const confirm = useConfirm();

  const handleRemove = async (id: string, symbol: string) => {
    const ok = await confirm({
      title: `从自选股移除 ${symbol}？`,
      description:
        '该股票将从自选列表移除。历史分析记录仍保留在「历史记录」中。',
      confirmText: '移除',
      danger: true,
    });
    if (!ok) return;
    setRemoving(id);
    try {
      await removeFromWatchlist(id);
      onChanged();
      toast.success(`已移除 · ${symbol}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '移除失败');
    } finally {
      setRemoving(null);
    }
  };

  const handleSaveNotes = async (id: string) => {
    setSavingNotes(true);
    try {
      await updateWatchlistItem(id, notesValue);
      onChanged();
      toast.success('已保存备注');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingNotes(false);
      setEditingNotes(null);
    }
  };

  if (items.length === 0) {
    return (
      <Card>
        <div className="px-6 py-10 text-center text-[13px] text-[var(--color-fg-3)]">
          暂无自选股 — 在上方搜索添加。
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>市场</th>
              <th>币种</th>
              <th>备注</th>
              <th>添加于</th>
              <th style={{ textAlign: 'right' }}></th>
            </tr>
          </THead>
          <TBody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link
                    href={stockHref(item.stock)}
                    className="hover:opacity-70 transition-opacity"
                  >
                    <Sym>{item.stock.symbol}</Sym>
                  </Link>
                </td>
                <td className="max-w-[200px] truncate">
                  <Link
                    href={stockHref(item.stock)}
                    className="text-[var(--color-fg)] hover:opacity-70"
                  >
                    {item.stock.name}
                  </Link>
                </td>
                <td>
                  <Pill variant="flat">
                    <span className="font-mono">
                      {MARKET_LABELS[item.stock.market] || item.stock.market}
                    </span>
                  </Pill>
                </td>
                <td>
                  <span className="font-mono text-[12.5px] text-[var(--color-fg-2)]">
                    {item.stock.currency}
                  </span>
                </td>
                <td className="max-w-[220px]">
                  {editingNotes === item.id ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        value={notesValue}
                        onChange={(e) => setNotesValue(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveNotes(item.id);
                          if (e.key === 'Escape') setEditingNotes(null);
                        }}
                        className={cn(
                          'w-full rounded-[6px] border border-[var(--color-border)] bg-[var(--color-bg)]',
                          'px-2 py-1 text-[13px] outline-none focus:border-[var(--color-fg)]',
                        )}
                      />
                      <button
                        onClick={() => handleSaveNotes(item.id)}
                        disabled={savingNotes}
                        className="text-[var(--color-accent-600)]"
                        aria-label="Save"
                      >
                        {savingNotes ? (
                          <Loader2
                            className="w-3.5 h-3.5 animate-spin"
                            strokeWidth={1.5}
                          />
                        ) : (
                          <Check className="w-3.5 h-3.5" strokeWidth={1.5} />
                        )}
                      </button>
                      <button
                        onClick={() => setEditingNotes(null)}
                        className="text-[var(--color-fg-3)] hover:text-[var(--color-fg)]"
                        aria-label="Cancel"
                      >
                        <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setEditingNotes(item.id);
                        setNotesValue(item.notes || '');
                      }}
                      className="group flex items-center gap-1.5 text-[13px] text-[var(--color-fg-2)] hover:text-[var(--color-fg)]"
                    >
                      {item.notes ? (
                        <span className="truncate">{item.notes}</span>
                      ) : (
                        <>
                          <StickyNote
                            className="w-3 h-3 opacity-0 group-hover:opacity-100"
                            strokeWidth={1.5}
                          />
                          <span className="opacity-0 group-hover:opacity-100">
                            添加备注
                          </span>
                        </>
                      )}
                    </button>
                  )}
                </td>
                <td>
                  <span className="font-mono text-[12px] text-[var(--color-fg-3)]">
                    {new Date(item.createdAt).toLocaleDateString('zh-CN')}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div className="flex justify-end gap-1.5">
                    <Link href={stockHref(item.stock)}>
                      <Button size="icon" variant="secondary" aria-label="Open">
                        <ArrowUpRight
                          className="w-3.5 h-3.5"
                          strokeWidth={1.5}
                        />
                      </Button>
                    </Link>
                    <Button
                      size="icon"
                      variant="secondary"
                      onClick={() => handleRemove(item.id, item.stock.symbol)}
                      disabled={removing === item.id}
                      aria-label="Remove"
                    >
                      {removing === item.id ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                      )}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </TBody>
        </Table>
        <TFoot>
          <span className="font-mono">共 {items.length} 只</span>
        </TFoot>
      </div>

      {/* Mobile compact list */}
      <div className="md:hidden">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-start gap-3 px-4 py-3 border-b border-[var(--color-border-soft)] last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Link href={stockHref(item.stock)}>
                  <Sym>{item.stock.symbol}</Sym>
                </Link>
                <Pill variant="flat">
                  <span className="font-mono">
                    {MARKET_LABELS[item.stock.market] || item.stock.market}
                  </span>
                </Pill>
              </div>
              <p className="mt-0.5 truncate text-[13px] text-[var(--color-fg-2)]">
                {item.stock.name}
              </p>
              {item.notes && (
                <p className="mt-1 truncate text-[12px] text-[var(--color-fg-3)]">
                  {item.notes}
                </p>
              )}
            </div>
            <Button
              size="icon"
              variant="secondary"
              onClick={() => handleRemove(item.id, item.stock.symbol)}
              disabled={removing === item.id}
              aria-label="Remove"
            >
              {removing === item.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
              )}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
