'use client';

import { Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Button, Card } from '@/components/ui';

export function ResolutionRecovery({
  symbol,
  candidates,
  onAddAndAnalyze,
  onAddOnly,
  busy,
}: {
  symbol: string;
  candidates: { symbol: string; name: string; market: string; exchange: string; currency: string; yahooSymbol?: string }[];
  onAddAndAnalyze: () => void;
  onAddOnly: () => void;
  busy: boolean;
}) {
  const top = candidates[0];
  return (
    <Card className="mb-6">
      <div className="px-6 py-10 text-center">
        <p className="text-[15px] font-medium text-[var(--color-fg)] m-0">
          {symbol} 还未在你的库里
        </p>
        <p className="mt-2 max-w-md mx-auto text-[12.5px] leading-[1.7] text-[var(--color-fg-2)]">
          从外部链接进入或这只股票还没有加入过自选股。加入自选后即可发起 AI 分析，分析记录会自动归档到这只股票下。
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" onClick={onAddAndAnalyze} disabled={busy}>
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
            ) : (
              <Sparkles className="w-3.5 h-3.5" strokeWidth={1.5} />
            )}
            加入自选并开始分析
          </Button>
          <Button onClick={onAddOnly} disabled={busy}>
            仅加入自选
          </Button>
          <Link
            href="/watchlist"
            className="text-[12.5px] text-[var(--color-fg-2)] hover:text-[var(--color-fg)] px-2"
          >
            返回自选股
          </Link>
        </div>
        {top && (
          <p className="mt-6 inline-flex items-center gap-2 font-mono text-[11px] text-[var(--color-fg-3)]">
            识别结果：
            <span className="text-[var(--color-fg-2)]">
              {top.symbol} · {top.name} · {top.exchange} · {top.currency}
            </span>
            <span>via Yahoo</span>
          </p>
        )}
      </div>
    </Card>
  );
}

export function ResolutionEmpty({ symbol }: { symbol: string }) {
  return (
    <Card className="mb-6">
      <div className="px-6 py-10 text-center">
        <p className="text-[15px] font-medium text-[var(--color-fg)] m-0">
          找不到 {symbol}
        </p>
        <p className="mt-2 max-w-md mx-auto text-[12.5px] leading-[1.7] text-[var(--color-fg-2)]">
          数据源没有匹配到这只股票。请检查 URL 中的 symbol 与 market 是否正确，或回到搜索重新选择。
        </p>
        <div className="mt-5">
          <Link href="/watchlist">
            <Button>返回自选股</Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}
