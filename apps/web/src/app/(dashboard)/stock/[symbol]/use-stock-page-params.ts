'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getRequestedAnalysisId } from './stock-page-ui';

export function useStockPageParams(params: Promise<{ symbol: string }>) {
  const [resolvedParams, setResolvedParams] = useState<{
    symbol: string;
  } | null>(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    params.then(setResolvedParams);
  }, [params]);

  const symbol = resolvedParams
    ? decodeURIComponent(resolvedParams.symbol)
    : null;
  const stockId = searchParams.get('stockId');
  const market = searchParams.get('market') || '';
  const name = searchParams.get('name') || symbol || '';
  const analysisId = getRequestedAnalysisId(searchParams);

  useEffect(() => {
    if (!symbol) return;
    const prev = document.title;
    document.title = name && name !== symbol ? `${symbol} · ${name}` : symbol;
    return () => {
      document.title = prev;
    };
  }, [symbol, name]);

  return {
    symbol,
    stockId,
    market,
    name,
    analysisId,
  };
}
