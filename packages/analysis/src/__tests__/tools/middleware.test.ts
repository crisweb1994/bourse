import { describe, expect, it, vi } from 'vitest';
import { BudgetExhaustedError } from '../../primitives/errors';
import { ToolMiddlewareRunner } from '../../tools/middleware';
import type {
  ToolCacheKey,
  ToolCachePort,
  ToolDescriptor,
  ToolResult,
} from '../../tools/types';

function rec(name: string, tokensIn = 100, tokensOut = 50) {
  return {
    toolName: name,
    startedAt: Date.now(),
    durationMs: 10,
    citationsCount: 1,
    tokensIn,
    tokensOut,
  };
}

describe('tools/ToolMiddlewareRunner — recording + counts', () => {
  it('tallies invocations + per-tool counts', () => {
    const m = new ToolMiddlewareRunner({});
    m.record(rec('webSearch'));
    m.record(rec('webSearch'));
    m.record(rec('peerLookup'));
    expect(m.totalCalls).toBe(3);
    expect(m.callsFor('webSearch')).toBe(2);
    expect(m.callsFor('peerLookup')).toBe(1);
  });

  it('totalCostUsd is 0 without a pricing function', () => {
    const m = new ToolMiddlewareRunner({});
    m.record(rec('webSearch', 1000, 500));
    expect(m.totalCostUsd).toBe(0);
  });

  it('applies pricing function when provided', () => {
    const m = new ToolMiddlewareRunner({
      pricing: (_t, tIn, tOut) => (tIn / 1_000_000) * 3 + (tOut / 1_000_000) * 15,
    });
    m.record(rec('webSearch', 1_000_000, 0)); // costs $3
    m.record(rec('webSearch', 0, 1_000_000)); // costs $15
    expect(m.totalCostUsd).toBeCloseTo(18, 5);
  });
});

describe('tools/ToolMiddlewareRunner — budget enforcement', () => {
  it('throws BudgetExhaustedError when maxCallsPerTool is exceeded', () => {
    const m = new ToolMiddlewareRunner({ maxCallsPerTool: { webSearch: 2 } });
    m.record(rec('webSearch'));
    m.record(rec('webSearch'));
    expect(() => m.record(rec('webSearch'))).toThrow(BudgetExhaustedError);
  });

  it('throws BudgetExhaustedError when maxTotalCalls is exceeded', () => {
    const m = new ToolMiddlewareRunner({ maxTotalCalls: 2 });
    m.record(rec('webSearch'));
    m.record(rec('peerLookup'));
    expect(() => m.record(rec('webSearch'))).toThrow(BudgetExhaustedError);
  });

  it('per-tool cap is independent across tools', () => {
    const m = new ToolMiddlewareRunner({ maxCallsPerTool: { webSearch: 1 } });
    m.record(rec('webSearch'));
    expect(() => m.record(rec('peerLookup'))).not.toThrow();
    expect(() => m.record(rec('webSearch'))).toThrow(BudgetExhaustedError);
  });
});

// ===== RFC-02 §9: ToolMiddlewareRunner.run (cache + retry + timeout) =====

function makeTool<T = { price: number }>(
  name: string,
  runFn: () => Promise<ToolResult<T>>,
): ToolDescriptor<{ symbol: string; market: string }, T> {
  return {
    name,
    description: `test tool ${name}`,
    providerInternal: false,
    market: 'CN',
    factField: 'quote',
    run: () => runFn(),
  };
}

function makeResult(data: unknown, citationsCount = 1): ToolResult<unknown> {
  return {
    data,
    citations: Array.from({ length: citationsCount }, (_, i) => ({
      title: `c${i}`,
      url: `https://example.com/${i}`,
      sourceType: 'OTHER' as const,
      retrievedAt: new Date().toISOString(),
    })),
    cost: { tokensIn: 0, tokensOut: 0 },
  };
}

class InMemoryCache implements ToolCachePort {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  async get(key: ToolCacheKey): Promise<unknown | null> {
    const k = `${key.toolName}:${key.market}:${key.symbol}`;
    const entry = this.store.get(k);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.value;
  }
  async set(key: ToolCacheKey, payload: unknown, ttlMs: number): Promise<void> {
    const k = `${key.toolName}:${key.market}:${key.symbol}`;
    this.store.set(k, { value: payload, expiresAt: Date.now() + ttlMs });
  }
  size(): number {
    return this.store.size;
  }
}

describe('tools/ToolMiddlewareRunner.run — cache', () => {
  it('serves from cache on hit and marks trace.cacheHit=true', async () => {
    const cache = new InMemoryCache();
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 100 })));
    const tool = makeTool('quoteSnapshot', runFn);
    const m = new ToolMiddlewareRunner({ cache });

    // First call → run + write
    const r1 = await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}, {
      cacheTtlMs: 60_000,
    });
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(r1.trace?.cacheHit).toBe(false);

    // Second call → served from cache, run not called again
    const r2 = await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}, {
      cacheTtlMs: 60_000,
    });
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(r2.trace?.cacheHit).toBe(true);
    expect((r2.data as { price: number }).price).toBe(100);
  });

  it('skips cache when cacheTtlMs is 0', async () => {
    const cache = new InMemoryCache();
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 50 })));
    const tool = makeTool('quoteSnapshot', runFn);
    const m = new ToolMiddlewareRunner({ cache });

    await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}, {});
    await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}, {});
    expect(runFn).toHaveBeenCalledTimes(2); // no caching, both call run
    expect(cache.size()).toBe(0);
  });

  it('cache.get failure falls through to execution (does not throw)', async () => {
    const brokenCache: ToolCachePort = {
      get: vi.fn(() => Promise.reject(new Error('DB down'))),
      set: vi.fn(() => Promise.resolve()),
    };
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 1 })));
    const tool = makeTool('quoteSnapshot', runFn);
    const m = new ToolMiddlewareRunner({ cache: brokenCache });

    const r = await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}, {
      cacheTtlMs: 60_000,
    });
    expect(runFn).toHaveBeenCalledTimes(1);
    expect((r.data as { price: number }).price).toBe(1);
  });
});

describe('tools/ToolMiddlewareRunner.run — retry', () => {
  it('retries on failure up to retries+1 times then throws', async () => {
    const runFn = vi.fn(() => Promise.reject(new Error('upstream error')));
    const tool = makeTool('quoteSnapshot', runFn);
    const m = new ToolMiddlewareRunner({});

    await expect(
      m.run(
        tool,
        { symbol: '600519.SS', market: 'CN' },
        {},
        { retries: 2, retryBackoffMs: [10, 10] },
      ),
    ).rejects.toThrow('upstream error');
    expect(runFn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('succeeds on second attempt without further retry', async () => {
    let calls = 0;
    const runFn = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('first fail'));
      return Promise.resolve(makeResult({ price: 200 }));
    });
    const tool = makeTool('quoteSnapshot', runFn);
    const m = new ToolMiddlewareRunner({});

    const r = await m.run(
      tool,
      { symbol: '600519.SS', market: 'CN' },
      {},
      { retries: 2, retryBackoffMs: [5, 5] },
    );
    expect(runFn).toHaveBeenCalledTimes(2);
    expect((r.data as { price: number }).price).toBe(200);
  });

  it('honors retry-after hint in error message for 429 backoff', async () => {
    let attempt = 0;
    const start = Date.now();
    const runFn = vi.fn(() => {
      attempt++;
      if (attempt === 1) {
        return Promise.reject(new Error('rate limit, retry-after: 1'));
      }
      return Promise.resolve(makeResult({ price: 3 }));
    });
    const tool = makeTool('quoteSnapshot', runFn);
    const m = new ToolMiddlewareRunner({});

    const r = await m.run(
      tool,
      { symbol: '600519.SS', market: 'CN' },
      {},
      { retries: 2, retryBackoffMs: [10000, 10000] }, // big default backoff
    );
    const elapsed = Date.now() - start;
    expect((r.data as { price: number }).price).toBe(3);
    // Should have used retry-after 1s, not the 10s default backoff
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('tools/ToolMiddlewareRunner.run — timeout', () => {
  it('throws timeout error when tool exceeds timeoutMs', async () => {
    const runFn = vi.fn(
      () =>
        new Promise<ToolResult<unknown>>((resolve) =>
          setTimeout(() => resolve(makeResult({})), 500),
        ),
    );
    const tool = makeTool('slowTool', runFn);
    const m = new ToolMiddlewareRunner({});

    await expect(
      m.run(
        tool,
        { symbol: '600519.SS', market: 'CN' },
        {},
        { timeoutMs: 100, retries: 0 },
      ),
    ).rejects.toThrow(/timeout/i);
  });
});

describe('tools/ToolMiddlewareRunner.run — record integration', () => {
  it('records each successful run via the existing record() pipeline', async () => {
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 10 })));
    const tool = makeTool('quoteSnapshot', runFn);
    const m = new ToolMiddlewareRunner({});

    await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {});
    await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {});

    expect(m.totalCalls).toBe(2);
    expect(m.callsFor('quoteSnapshot')).toBe(2);
  });

  it('records cache hits as invocations too (cacheHit: true)', async () => {
    const cache = new InMemoryCache();
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 10 })));
    const tool = makeTool('quoteSnapshot', runFn);
    const m = new ToolMiddlewareRunner({ cache });

    await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}, {
      cacheTtlMs: 60_000,
    });
    await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}, {
      cacheTtlMs: 60_000,
    });

    // 2 invocations recorded; only 1 actually called upstream
    expect(m.totalCalls).toBe(2);
    expect(runFn).toHaveBeenCalledTimes(1);
    const invocations = m.getInvocations();
    expect(invocations[0].cacheHit).toBe(false);
    expect(invocations[1].cacheHit).toBe(true);
  });

  it('throws if tool has no run() (provider-internal)', async () => {
    const tool: ToolDescriptor<{ symbol: string; market: string }, unknown> = {
      name: 'web_search',
      description: 'provider-internal',
      providerInternal: true,
      // no run()
    };
    const m = new ToolMiddlewareRunner({});
    await expect(
      m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}),
    ).rejects.toThrow(/no run/);
  });
});

// ===== RFC-09 §6: ToolPolicy.budgetCapUsd + traceTag =====

describe('tools/ToolMiddlewareRunner.run — budgetCapUsd (RFC-09 P2)', () => {
  it('throws BudgetExhaustedError("toolBudget") when cost exceeds cap', async () => {
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 100 })));
    const tool = makeTool('expensiveTool', runFn);
    const m = new ToolMiddlewareRunner({
      pricing: (toolName) => (toolName === 'expensiveTool' ? 0.05 : 0),
    });

    await expect(
      m.run(
        tool,
        { symbol: '600519.SS', market: 'CN' },
        {},
        { budgetCapUsd: 0.01 },
      ),
    ).rejects.toMatchObject({
      name: 'BudgetExhaustedError',
      limit: 'toolBudget',
    });
    expect(runFn).toHaveBeenCalledTimes(1); // run completed before throw
  });

  it('does NOT throw when cost <= budgetCapUsd', async () => {
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 100 })));
    const tool = makeTool('cheapTool', runFn);
    const m = new ToolMiddlewareRunner({
      pricing: (toolName) => (toolName === 'cheapTool' ? 0.001 : 0),
    });

    await expect(
      m.run(
        tool,
        { symbol: '600519.SS', market: 'CN' },
        {},
        { budgetCapUsd: 0.01 },
      ),
    ).resolves.toBeDefined();
  });

  it('omitting budgetCapUsd is inert (pre-RFC-09 behavior preserved)', async () => {
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 100 })));
    const tool = makeTool('expensiveTool', runFn);
    const m = new ToolMiddlewareRunner({
      pricing: () => 100, // huge cost
    });

    await expect(
      m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}, {}),
    ).resolves.toBeDefined();
  });
});

describe('tools/ToolMiddlewareRunner.run — retry-after cap (hotfix 2026-05-15)', () => {
  it('caps retry-after at 5s even when error says 30s (anti-scrape WAF guard)', async () => {
    let attempts = 0;
    const runFn = vi.fn(() => {
      attempts++;
      // First two attempts mimic an upstream 429 → tool hardcodes "retry-after: 30"
      if (attempts <= 2) {
        return Promise.reject(new Error('tencent 429 retry-after: 30'));
      }
      return Promise.resolve(makeResult({ price: 100 }));
    });
    const tool = makeTool('rateLimitedTool', runFn);
    const m = new ToolMiddlewareRunner({});

    const startedAt = Date.now();
    await m.run(
      tool,
      { symbol: '600519.SS', market: 'CN' },
      {},
      { retries: 2, retryBackoffMs: [0, 0] },
    );
    const elapsed = Date.now() - startedAt;

    expect(attempts).toBe(3); // 2 retries × 30s sleep would have been ≈60s
    // 5s cap × 2 sleeps = 10s upper bound; allow ample slack but reject >20s
    expect(elapsed).toBeLessThan(20_000);
    expect(elapsed).toBeGreaterThanOrEqual(10_000); // cap actually applied
  }, 25_000);
});

describe('tools/ToolMiddlewareRunner.run — traceTag propagation (RFC-09 P2)', () => {
  it('writes policy.traceTag into ToolInvocationRecord', async () => {
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 100 })));
    const tool = makeTool('quoteSnapshotCN', runFn);
    const m = new ToolMiddlewareRunner({});

    await m.run(
      tool,
      { symbol: '600519.SS', market: 'CN' },
      {},
      { traceTag: 'FUNDAMENTAL-abc123' },
    );

    const inv = m.getInvocations();
    expect(inv).toHaveLength(1);
    expect(inv[0].traceTag).toBe('FUNDAMENTAL-abc123');
  });

  it('defaults traceTag to tool.name when policy omits it', async () => {
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 100 })));
    const tool = makeTool('lhbScanCN', runFn);
    const m = new ToolMiddlewareRunner({});

    await m.run(tool, { symbol: '600519.SS', market: 'CN' }, {}, {});

    const inv = m.getInvocations();
    expect(inv[0].traceTag).toBe('lhbScanCN');
  });

  it('preserves traceTag on cache-hit replay too', async () => {
    const cache = new InMemoryCache();
    const runFn = vi.fn(() => Promise.resolve(makeResult({ price: 100 })));
    const tool = makeTool('quoteSnapshotCN', runFn);
    const m = new ToolMiddlewareRunner({ cache });

    await m.run(
      tool,
      { symbol: '600519.SS', market: 'CN' },
      {},
      { cacheTtlMs: 60_000, traceTag: 'wave-1' },
    );
    await m.run(
      tool,
      { symbol: '600519.SS', market: 'CN' },
      {},
      { cacheTtlMs: 60_000, traceTag: 'wave-2' },
    );

    const inv = m.getInvocations();
    expect(inv[0].traceTag).toBe('wave-1');
    expect(inv[0].cacheHit).toBe(false);
    expect(inv[1].traceTag).toBe('wave-2');
    expect(inv[1].cacheHit).toBe(true);
  });
});
