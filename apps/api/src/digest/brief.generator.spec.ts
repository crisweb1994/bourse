import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PriceBar } from '@bourse/analysis';
import { DigestGeneratorService } from './brief.generator';

// ============================================================================
// 单测：DigestGeneratorService。
// 注入 stub 的 prisma / snapshotV2 / providerFactory / aiSettings + deps.index /
// deps.computeTech（指数层 + 技术指标），不碰真实网络与 LLM。
// 守不变式：数字来自 stub（compute 的替身），LLM 只解读（provider.complete 只回文本）。
// ============================================================================

// ---- 类型替身 ---------------------------------------------------------------

function bars(closes: number[]): PriceBar[] {
  const base = Date.UTC(2025, 0, 1) / 1000;
  return closes.map((c, i) => ({
    timestamp: new Date((base + i * 86_400) * 1000).toISOString(),
    open: c,
    high: c,
    low: c,
    close: c,
  }));
}

function snapshot({
  symbol,
  price,
  changePct,
  history,
  sma50,
  sma200,
  rsi14,
  unlockEvents,
}: {
  symbol: string;
  price: number;
  changePct: number;
  history?: PriceBar[];
  sma50?: number | null;
  sma200?: number | null;
  rsi14?: number | null;
  unlockEvents?: unknown;
}): any {
  const lastClose = history?.at(-1)?.close ?? price;
  return {
    symbol,
    market: 'US',
    capturedAt: '2026-06-27T13:00:00.000Z',
    rawFacts: {
      quote: {
        instrument: { instrumentId: `US:${symbol}`, market: 'US', symbol },
        price,
        changePct,
        currency: 'USD',
        timestamp: '2026-06-27T13:00:00.000Z',
      },
      history: history ?? null,
      profile: null,
      financials: null,
      filings: null,
      consensusEps: null,
      northboundFlow: null,
      lhb: null,
      unlockCalendar: unlockEvents ?? null,
      shareholders: null,
      webSearch: null,
      macro: null,
    },
    computedFacts: {
      technicalIndicators:
        sma50 === undefined && sma200 === undefined && rsi14 === undefined
          ? null
          : {
              lastClose,
              sma50: sma50 ?? null,
              sma200: sma200 ?? null,
              rsi14: rsi14 ?? null,
            },
      financialRatios: null,
      redFlags: [],
      valuation: null,
      peerComparison: null,
      historicalContext: [],
    },
    citations: [],
    dataAvailability: { available: ['quote'], missing: [], warnings: [] },
  };
}

// ---- 测试 harness -----------------------------------------------------------

interface Harness {
  svc: DigestGeneratorService;
  calls: { complete: string[] };
  setDefaultRuntime(rt: any | null): void;
}

function makeHarness(opts: {
  watchlist?: any[];
  analysesByStock?: Record<string, any>;
  indexQuote?: any;
  indexHistory?: PriceBar[] | null;
  completeText?: string | ((prompt: string) => string);
  snapshotBySymbol?: Record<string, any>;
}): Harness {
  const calls: { complete: string[] } = { complete: [] };

  // aiSettings.getDefaultRuntime
  let defaultRuntime: any | null = null;

  // providerFactory.buildFromRuntime → fake provider whose complete() records + returns text
  const providerFactory: any = {
    buildFromRuntime(rt: any) {
      if (!rt) throw new Error('buildFromRuntime called with null runtime');
      return {
        name: 'fake',
        stream: () => Promise.reject(new Error('not used')),
        complete: async (_sys: string, user: string) => {
          calls.complete.push(user);
          const t =
            typeof opts.completeText === 'function'
              ? opts.completeText(user)
              : opts.completeText ?? 'AI 解读';
          return { text: t, usage: { tokensIn: 1, tokensOut: 1 } };
        },
        getModel: () => rt.model ?? 'm',
        getUtilityModel: () => rt.utilityModel ?? 'jm',
      };
    },
  };

  const aiSettings: any = {
    getDefaultRuntime: async () => defaultRuntime,
  };

  const snapshotV2: any = {
    fetch: async (symbol: string) => {
      const bySym = opts.snapshotBySymbol ?? {};
      if (bySym[symbol]) return bySym[symbol];
      throw new Error(`no snapshot stub for ${symbol}`);
    },
  };

  const watchlistRows = opts.watchlist ?? [];

  const prisma: any = {
    watchlistItem: {
      findMany: async () => watchlistRows,
    },
    analysis: {
      findFirst: async (args: any) => {
        const stockId: string = args.where.stockId;
        return (opts.analysesByStock ?? {})[stockId] ?? null;
      },
    },
  };

  const config: any = {
    get: () => undefined, // 全部走 DB.5 初值
  };

  // deps.index stub: 单指数 ^GSPC，返回固定 quote/history；其它返回 null。
  const index = {
    quote: async (sym: string) =>
      sym === '^GSPC'
        ? {
            symbol: sym,
            name: 'S&P 500',
            price: 5000,
            previousClose: 4950,
            change: 50,
            changePct: opts.indexQuote?.changePct ?? 1.01,
            currency: 'USD',
            exchange: 'SNP',
            timestamp: opts.indexQuote?.timestamp ?? '2026-06-27T13:00:00.000Z',
          }
        : null,
    history: async () => opts.indexHistory ?? null,
  };

  // deps.computeTech stub：直接把 sma50/rsi14 还回去，避免造 200 根 bar。
  const computeTech: any = (input: { bars: PriceBar[] }) => {
    const last = input.bars.at(-1)?.close ?? null;
    return {
      indicators: {
        lastClose: last,
        sma50: 4900,
        sma200: 4800,
        rsi14: 55,
      },
      warnings: [],
    };
  };

  const svc = new DigestGeneratorService(
    prisma,
    snapshotV2,
    providerFactory,
    aiSettings,
    config,
    { index, computeTech },
  );

  return {
    svc,
    calls,
    setDefaultRuntime(rt) {
      defaultRuntime = rt;
    },
  };
}

const US_STOCK = (id: string, symbol: string, sector?: string) => ({
  id,
  stockId: id,
  userId: 'u1',
  order: 0,
  stock: { id, symbol, market: 'US', sector: sector ?? null },
});

// ============================================================================
// Tests
// ============================================================================

describe('DigestGeneratorService · 两段组装', () => {
  it('正常组装 Market Overview + Watchlist，AI 解读非空', async () => {
    const h = makeHarness({
      watchlist: [US_STOCK('s1', 'AAPL', 'Technology')],
      snapshotBySymbol: {
        AAPL: snapshot({
          symbol: 'AAPL',
          price: 200,
          changePct: 0.5,
          sma50: 190,
          sma200: 180,
          rsi14: 55,
        }),
      },
    });
    h.setDefaultRuntime({ id: 'rt1', model: 'gpt-x', utilityModel: 'gpt-mini' });

    const out = await h.svc.generate('u1', 'US', 'PRE');

    // Market Overview
    assert.equal(out.marketOverview.indices.length, 1);
    assert.equal(out.marketOverview.indices[0]!.symbol, '^GSPC');
    assert.equal(out.marketOverview.indices[0]!.name, 'S&P 500');
    assert.ok(out.marketOverview.interpretation); // AI 大盘解读
    // 守不变式 #1：compute 数字注入了 prompt（sma50=4900, lastClose=5000 → +2.04%）
    assert.match(h.calls.complete[0]!, /距 SMA50/);

    // Watchlist
    assert.equal(out.watchlist.items.length, 1);
    assert.equal(out.watchlist.items[0]!.symbol, 'AAPL');
    assert.equal(out.watchlist.items[0]!.changePct, 0.5);
    assert.ok(out.watchlist.interpretation); // AI 自选聚合
  });

  it('POST 触发板块归因（Stock.sector 分组）', async () => {
    const h = makeHarness({
      watchlist: [
        US_STOCK('s1', 'AAPL', 'Technology'),
        US_STOCK('s2', 'MSFT', 'Technology'),
        US_STOCK('s3', 'XOM', 'Energy'),
      ],
      snapshotBySymbol: {
        AAPL: snapshot({ symbol: 'AAPL', price: 1, changePct: 2, sma50: 1, sma200: 1, rsi14: 50 }),
        MSFT: snapshot({ symbol: 'MSFT', price: 1, changePct: 4, sma50: 1, sma200: 1, rsi14: 50 }),
        XOM: snapshot({ symbol: 'XOM', price: 1, changePct: -1, sma50: 1, sma200: 1, rsi14: 50 }),
      },
    });
    h.setDefaultRuntime({ id: 'rt1', utilityModel: 'gpt-mini' });

    const out = await h.svc.generate('u1', 'US', 'POST');
    const tech = out.watchlist.sectorAttribution.find((s) => s.sector === 'Technology');
    const energy = out.watchlist.sectorAttribution.find((s) => s.sector === 'Energy');
    assert.ok(tech, 'Technology group present');
    assert.equal(tech!.changePct, 3); // (2 + 4) / 2
    assert.ok(energy);
    assert.equal(energy!.changePct, -1);
  });

  it('PRE 不产板块归因（空数组）', async () => {
    const h = makeHarness({
      watchlist: [US_STOCK('s1', 'AAPL', 'Technology')],
      snapshotBySymbol: {
        AAPL: snapshot({ symbol: 'AAPL', price: 1, changePct: 2, sma50: 1, sma200: 1, rsi14: 50 }),
      },
    });
    h.setDefaultRuntime({ id: 'rt1', utilityModel: 'gpt-mini' });

    const out = await h.svc.generate('u1', 'US', 'PRE');
    assert.deepEqual(out.watchlist.sectorAttribution, []);
  });
});

describe('DigestGeneratorService · 降级（用户未配 provider）', () => {
  it('interpretation=null、deepDive=null，但数字段齐全', async () => {
    const h = makeHarness({
      watchlist: [US_STOCK('s1', 'AAPL', 'Technology')],
      snapshotBySymbol: {
        AAPL: snapshot({
          symbol: 'AAPL',
          price: 200,
          changePct: 5, // 命中 big_move 异动 → 但无 provider 不应深入
          sma50: 190,
          sma200: 180,
          rsi14: 75,
        }),
      },
    });
    h.setDefaultRuntime(null); // 用户未配 provider

    const out = await h.svc.generate('u1', 'US', 'PRE');

    assert.equal(out.marketOverview.interpretation, null);
    assert.equal(out.watchlist.interpretation, null);
    assert.equal(out.watchlist.items[0]!.deepDive, null);
    // 数字段仍齐全
    assert.equal(out.watchlist.items[0]!.changePct, 5);
    assert.equal(out.watchlist.items[0]!.rsi14, 75);
    // LLM 一次都没被调用
    assert.equal(h.calls.complete.length, 0);
  });
});

describe('DigestGeneratorService · 异动深入', () => {
  it('命中异动 → deepDive 非空', async () => {
    const h = makeHarness({
      watchlist: [US_STOCK('s1', 'AAPL', 'Technology')],
      snapshotBySymbol: {
        AAPL: snapshot({
          symbol: 'AAPL',
          price: 200,
          changePct: -4, // |−4%| ≥ 3% → 命中 big_move
          sma50: 210,
          sma200: 220,
          rsi14: 25, // ≤ 30 → oversold
        }),
      },
    });
    h.setDefaultRuntime({ id: 'rt1', utilityModel: 'gpt-mini' });

    const out = await h.svc.generate('u1', 'US', 'PRE');
    assert.equal(out.watchlist.items[0]!.deepDive, 'AI 解读');
  });

  it('未命中异动 → deepDive=null', async () => {
    const h = makeHarness({
      watchlist: [US_STOCK('s1', 'AAPL', 'Technology')],
      snapshotBySymbol: {
        AAPL: snapshot({
          symbol: 'AAPL',
          price: 200,
          changePct: 0.5, // 无异动
          sma50: 190,
          sma200: 180,
          rsi14: 55,
        }),
      },
      analysesByStock: {
        s1: {
          overallSignal: 'BULLISH',
          createdAt: new Date(),
          dataAsOf: '2026-06-20',
        },
      },
    });
    h.setDefaultRuntime({ id: 'rt1', utilityModel: 'gpt-mini' });

    const out = await h.svc.generate('u1', 'US', 'PRE');
    assert.equal(out.watchlist.items[0]!.deepDive, null);
    // 自选聚合解读仍应调用（1 次），deepDive 不调（0 次）→ 共 1 次（+大盘 1 次 = 2）
    assert.equal(h.calls.complete.length, 2);
  });
});

describe('DigestGeneratorService · 距上次分析漂移', () => {
  it('有历史 Analysis + history 可校准 → drift 非空', async () => {
    // dataAsOf = 2026-06-20；history 里有 06-20 收盘 180；现价 200 → +11.11%
    const h = makeHarness({
      watchlist: [US_STOCK('s1', 'AAPL', 'Technology')],
      snapshotBySymbol: {
        AAPL: snapshot({
          symbol: 'AAPL',
          price: 200,
          changePct: 0.5,
          history: bars([100, 110, 120, 180, 200]).map((b, i) => ({
            ...b,
            // 让最后一根前那根日期 = 06-20（drift 取 ≤ dataAsOf 最近一根）
            timestamp:
              i === 3
                ? '2026-06-20T00:00:00.000Z'
                : i === 4
                  ? '2026-06-27T00:00:00.000Z'
                  : b.timestamp,
          })),
          sma50: 190,
          sma200: 180,
          rsi14: 55,
        }),
      },
      analysesByStock: {
        s1: {
          overallSignal: 'BULLISH',
          createdAt: new Date('2026-06-20'),
          dataAsOf: '2026-06-20',
        },
      },
    });
    h.setDefaultRuntime({ id: 'rt1', utilityModel: 'gpt-mini' });

    const out = await h.svc.generate('u1', 'US', 'PRE');
    // 200/180 - 1 ≈ 0.1111…
    assert.ok(
      Math.abs((out.watchlist.items[0]!.driftSinceLastAnalysis ?? NaN) - 11.11) < 0.01,
    );
  });

  it('无历史 Analysis → driftSinceLastAnalysis=null', async () => {
    const h = makeHarness({
      watchlist: [US_STOCK('s1', 'AAPL', 'Technology')],
      snapshotBySymbol: {
        AAPL: snapshot({
          symbol: 'AAPL',
          price: 200,
          changePct: 0.5,
          sma50: 190,
          sma200: 180,
          rsi14: 55,
        }),
      },
      analysesByStock: {}, // 无历史 Analysis
    });
    h.setDefaultRuntime({ id: 'rt1', utilityModel: 'gpt-mini' });

    const out = await h.svc.generate('u1', 'US', 'PRE');
    assert.equal(out.watchlist.items[0]!.driftSinceLastAnalysis, null);
  });
});

describe('DigestGeneratorService · 边界', () => {
  it('空自选 → 只大盘段，watchlist items 空', async () => {
    const h = makeHarness({ watchlist: [] });
    h.setDefaultRuntime({ id: 'rt1', utilityModel: 'gpt-mini' });

    const out = await h.svc.generate('u1', 'US', 'PRE');
    assert.equal(out.watchlist.items.length, 0);
    assert.equal(out.watchlist.interpretation, null);
    assert.ok(out.marketOverview.indices.length > 0);
  });

  it('指数拉不到 → 大盘段空但不抛', async () => {
    const h = makeHarness({
      watchlist: [US_STOCK('s1', 'AAPL', 'Technology')],
      snapshotBySymbol: {
        AAPL: snapshot({
          symbol: 'AAPL',
          price: 200,
          changePct: 0.5,
          sma50: 190,
          sma200: 180,
          rsi14: 55,
        }),
      },
      indexQuote: null as any, // quote stub 返回 null（已在 harness 里 ^GSPC 才返；这里强制走 fallback）
    });
    // 改写 index.quote 让所有指数返 null
    (h as any).svc.index.quote = async () => null;
    h.setDefaultRuntime({ id: 'rt1', utilityModel: 'gpt-mini' });

    const out = await h.svc.generate('u1', 'US', 'PRE');
    assert.equal(out.marketOverview.indices.length, 0);
    assert.equal(out.marketOverview.interpretation, null);
    assert.equal(out.watchlist.items.length, 1); // 自选段不受影响
  });

  it('BriefPayload 结构符合 schema（market/session/generatedAt 齐全）', async () => {
    const h = makeHarness({ watchlist: [] });
    h.setDefaultRuntime(null);
    const out = await h.svc.generate('u1', 'US', 'POST');
    assert.equal(out.market, 'US');
    assert.equal(out.session, 'POST');
    assert.match(out.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(typeof out.dataAsOf === 'string');
  });
});
