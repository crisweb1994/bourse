import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StockHistoryResponseSchema, STOCK_HISTORY_DAYS_WHITELIST } from '@bourse/shared-types';
import type { PriceBar } from '@bourse/market-data';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StockService } from './stock.service';

/**
 * Contract tests for GET /api/stocks/:symbol/history (visualization §五⑦).
 * Response must parse against the shared zod schema on every branch.
 */

function bar(i: number): PriceBar {
  const close = 100 + i;
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    adjustedClose: close * 0.5, // forces the derived basis path
    volume: 1_000 + i,
  };
}

function serviceWithHistory(bars: PriceBar[] | null) {
  const marketData = {
    getHistory: async () => ({
      data: bars ?? [],
      citations: [{ title: 'Yahoo', url: 'https://finance.yahoo.com', sourceType: 'OTHER', retrievedAt: '2026-08-15T00:00:00.000Z', qualityTier: 'B' }],
      freshness: [],
      warnings: [],
      trace: {},
    }),
  };
  return new StockService(
    {} as never,
    marketData as never,
    {} as never,
  );
}

test('history: invalid market → 400', async () => {
  await assert.rejects(
    () => serviceWithHistory([]).getChartHistory('AAPL', 'XX'),
    BadRequestException,
  );
});

test('history: days outside whitelist → 400', async () => {
  await assert.rejects(
    () => serviceWithHistory([]).getChartHistory('AAPL', 'US', 45),
    BadRequestException,
  );
});

test('history: whitelist values accepted (30/90/365/1095)', async () => {
  const bars = Array.from({ length: 40 }, (_, i) => bar(i));
  const service = serviceWithHistory(bars);
  for (const days of STOCK_HISTORY_DAYS_WHITELIST) {
    await service.getChartHistory('AAPL', 'US', days); // must not throw
  }
});

test('history: empty bars → 404 with honest message', async () => {
  await assert.rejects(
    () => serviceWithHistory([]).getChartHistory('AAPL', 'US'),
    NotFoundException,
  );
});

test('history: happy path → schema-valid, derived basis, server-computed series', async () => {
  const bars = Array.from({ length: 260 }, (_, i) => bar(i));
  const res = await serviceWithHistory(bars).getChartHistory('AAPL', 'US', 365);
  const parsed = StockHistoryResponseSchema.safeParse(res);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? '' : parsed.error.issues));

  // I1: adjustedClose-based candles (factor 0.5 → basis derived, c = 0.5×close)
  assert.equal(res.priceSeries.basis, 'derived');
  assert.equal(res.priceSeries.bars.at(-1)!.c, bars.at(-1)!.adjustedClose);
  // 260 bars ≥ 200 → week52 populated
  assert.notEqual(res.priceSeries.week52High, null);
  // P1: indicators computed server-side, series carried, sma200 converged
  const tech = res.technical as { sma200: number | null; series?: { sma20: Array<{ t: string; v: number }> } };
  assert.notEqual(tech.sma200, null);
  assert.equal(tech.series!.sma20.length, 260 - 19);
  // provenance tier flows from the connector citation
  assert.equal(res.provenance.history, 'B');
});

test('history: market prefix composes the instrument id (F10)', async () => {
  let seenInstrument = '';
  const marketData = {
    getHistory: async (input: { instrumentId: string }) => {
      seenInstrument = input.instrumentId;
      return serviceWithHistory([]) && { data: [], citations: [], freshness: [], warnings: [], trace: {} };
    },
  };
  const service = new StockService({} as never, marketData as never, {} as never);
  await service.getChartHistory('600519', 'CN', 365).catch(() => undefined);
  assert.equal(seenInstrument, 'CN:600519');
});

test('history: suffixed URL symbols are normalized for CN/HK (bug fix — bare code for the router)', async () => {
  const seen: string[] = [];
  const marketData = {
    getHistory: async (input: { instrumentId: string }) => {
      seen.push(input.instrumentId);
      return { data: [], citations: [], freshness: [], warnings: [], trace: {} };
    },
  };
  const service = new StockService({} as never, marketData as never, {} as never);
  await service.getChartHistory('600519.SS', 'CN', 365).catch(() => undefined);
  await service.getChartHistory('000725.SZ', 'CN', 365).catch(() => undefined);
  await service.getChartHistory('0700.HK', 'HK', 365).catch(() => undefined);
  await service.getChartHistory('BRK.B', 'US', 365).catch(() => undefined);
  assert.deepEqual(seen, ['CN:600519', 'CN:000725', 'HK:0700', 'US:BRK.B']);
});
