import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  FilingPort,
  FinancePort,
  FinancialsPort,
  Quote,
  ResearchResult,
} from '@bourse/analysis';
import { SnapshotV2Service } from './snapshot-v2.service';

// ============================================================================
// Helpers — minimal port stubs
// ============================================================================

function envelope<T>(data: T): ResearchResult<T> {
  return {
    schemaVersion: '1.0',
    data,
    citations: [],
    freshness: [],
    warnings: [],
  } as unknown as ResearchResult<T>;
}

function aaplQuote(): Quote {
  return {
    instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
    price: 200,
    currency: 'USD',
    timestamp: '2025-05-25T00:00:00.000Z',
    marketCap: 600_000_000_000,
  };
}

function mockYahoo(quoteImpl?: () => Promise<ResearchResult<Quote | null>>): FinancePort {
  return {
    async getQuote() {
      if (quoteImpl) return quoteImpl();
      return envelope(aaplQuote());
    },
    async getHistory() {
      return envelope([]);
    },
    async getProfile() {
      // Bare instrument, no descriptive fields → fetcher returns null → no_data.
      return envelope({ instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' } });
    },
  } as unknown as FinancePort;
}

function mockCnFinance(): FinancePort {
  return {
    async getQuote() {
      return envelope(null) as unknown as ResearchResult<Quote>;
    },
    async getHistory() {
      return envelope([]);
    },
    async getProfile() {
      return envelope({ instrument: { instrumentId: 'CN:600519', market: 'CN', symbol: '600519' } });
    },
  } as unknown as FinancePort;
}

function mockFinancials(): FinancialsPort {
  return {
    async fetchFinancials() {
      return envelope(null);
    },
  } as unknown as FinancialsPort;
}

function mockFilings(): FilingPort {
  return {
    async searchFilings() {
      return envelope([]);
    },
    async getFiling() {
      return envelope(null);
    },
  } as unknown as FilingPort;
}

function buildService(overrides: { yahoo?: FinancePort } = {}): SnapshotV2Service {
  // Direct constructor — avoids @nestjs/testing dep
  return new SnapshotV2Service(
    overrides.yahoo ?? mockYahoo(),
    mockCnFinance(),
    mockFinancials(), // US financials
    mockFinancials(), // CN financials
    mockFinancials(), // HK financials
    mockFilings(),
    mockFilings(),
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('SnapshotV2Service', () => {
  it('fetches a US snapshot via the wired Yahoo port', async () => {
    const svc = buildService();
    const snap = await svc.fetch('AAPL', 'US');
    assert.equal(snap.symbol, 'AAPL');
    assert.equal(snap.market, 'US');
    assert.equal(snap.rawFacts.quote?.price, 200);
    assert.ok(snap.dataAvailability.available.includes('quote'));
  });

  it('CN wiring: 5 CN tools + profile registered; only webSearch/macro stay not_configured', async () => {
    const svc = buildService();
    const snap = await svc.fetch('600519', 'CN', { perConnectorTimeoutMs: 100 });
    const notConfigured = snap.dataAvailability.missing
      .filter((m) => m.reason === 'not_configured')
      .map((m) => m.field);
    // CN config has quote / history / profile / financials / filings /
    // consensusEps / lhb / northboundFlow / unlockCalendar / shareholders wired.
    // Unwired in current scope: webSearch / macro.
    for (const expected of ['webSearch', 'macro']) {
      assert.ok(
        notConfigured.includes(expected),
        `expected '${expected}' in not_configured set, got [${notConfigured.join(',')}]`,
      );
    }
    // The 5 CN tools + profile must NOT be in not_configured — they're wired now.
    for (const cnTool of [
      'profile', 'consensusEps', 'lhb', 'northboundFlow', 'unlockCalendar', 'shareholders',
    ]) {
      assert.ok(
        !notConfigured.includes(cnTool),
        `'${cnTool}' should be wired (reason should NOT be not_configured), got [${notConfigured.join(',')}]`,
      );
    }
  });

  it('honors per-connector timeout when the port hangs', async () => {
    const hanging = mockYahoo(() => new Promise(() => undefined));
    const svc = buildService({ yahoo: hanging });
    const snap = await svc.fetch('AAPL', 'US', { perConnectorTimeoutMs: 50 });
    const quoteMiss = snap.dataAvailability.missing.find((m) => m.field === 'quote');
    assert.equal(quoteMiss?.reason, 'timeout');
  });
});
