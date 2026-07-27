import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  FilingPort,
  CompanyProfilePort,
  FinancePort,
  FinancialsPort,
  MacroPort,
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

function mockNasdaq(): FinancePort {
  return {
    async getQuote() {
      return envelope({
        instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
        price: 201,
        currency: 'USD',
        timestamp: '2025-05-25T00:00:00.000Z',
      });
    },
    async getHistory() {
      return envelope(Array.from({ length: 30 }, (_, index) => ({
        timestamp: new Date(Date.UTC(2025, 3, index + 1)).toISOString(),
        open: 198 + index,
        high: 202 + index,
        low: 197 + index,
        close: 201 + index,
        volume: 1_000_000,
      })));
    },
  } as unknown as FinancePort;
}

function mockSina(): FinancePort {
  return {
    async getQuote() {
      return envelope({
        instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
        price: 202,
        currency: 'USD',
        timestamp: '2025-05-25T00:00:00.000Z',
      });
    },
    async getHistory() {
      return envelope(Array.from({ length: 30 }, (_, index) => ({
        timestamp: new Date(Date.UTC(2025, 3, index + 1)).toISOString(),
        open: 199 + index,
        high: 203 + index,
        low: 198 + index,
        close: 202 + index,
        volume: 900_000,
      })));
    },
  } as unknown as FinancePort;
}

function mockUsProfile(): CompanyProfilePort {
  return {
    async getProfile() {
      return envelope({
        instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
      });
    },
  };
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

function mockMacro(): MacroPort {
  return {
    async fetchMacro(input) {
      return envelope({ market: input.market, observations: [] });
    },
  } as MacroPort;
}

function buildService(overrides: {
  yahoo?: FinancePort;
  nasdaq?: FinancePort;
  sina?: FinancePort;
  usFilings?: FilingPort;
} = {}): SnapshotV2Service {
  // Direct constructor — avoids @nestjs/testing dep
  return new SnapshotV2Service(
    overrides.yahoo ?? mockYahoo(),
    overrides.nasdaq ?? mockNasdaq(),
    overrides.sina ?? mockSina(),
    mockSina(), // Tencent HK fallback (unused by US tests)
    mockUsProfile(),
    mockCnFinance(),
    mockFinancials(), // US financials
    mockFinancials(), // CN financials
    mockFinancials(), // HK financials
    overrides.usFilings ?? mockFilings(),
    mockFilings(),
    mockFilings(),
    mockMacro(),
    null,
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

  it('uses Nasdaq quote and history when Yahoo returns unusable data', async () => {
    const unavailableYahoo: FinancePort = {
      async getQuote() {
        return envelope({
          instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
          price: Number.NaN,
          currency: 'USD',
          timestamp: '1970-01-01T00:00:00.000Z',
        });
      },
      async getHistory() {
        return envelope([]);
      },
      async getProfile() {
        return envelope({ instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' } });
      },
    } as unknown as FinancePort;
    const svc = buildService({ yahoo: unavailableYahoo });
    const snap = await svc.fetch('AAPL', 'US');

    assert.equal(snap.rawFacts.quote?.price, 201);
    assert.equal(snap.rawFacts.history?.length, 30);
    assert.ok(
      snap.dataAvailability.warnings.some((warning) =>
        warning.includes('Nasdaq fallback was used'),
      ),
    );
  });

  it('uses Sina quote and history when Yahoo and Nasdaq are both unusable', async () => {
    const unavailable: FinancePort = {
      async getQuote() {
        return envelope({
          instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' },
          price: Number.NaN,
          currency: 'USD',
          timestamp: '1970-01-01T00:00:00.000Z',
        });
      },
      async getHistory() {
        return envelope([]);
      },
      async getProfile() {
        return envelope({ instrument: { instrumentId: 'US:AAPL', market: 'US', symbol: 'AAPL' } });
      },
    } as unknown as FinancePort;
    const svc = buildService({ yahoo: unavailable, nasdaq: unavailable });
    const snap = await svc.fetch('AAPL', 'US');

    assert.equal(snap.rawFacts.quote?.price, 202);
    assert.equal(snap.rawFacts.history?.length, 30);
    assert.ok(
      snap.dataAvailability.warnings.some((warning) =>
        warning.includes('Sina Finance fallback was used'),
      ),
    );
  });

  it('collects periodic and issuer-side insider filings as separate SEC queries', async () => {
    const forms: string[][] = [];
    const usFilings: FilingPort = {
      async searchFilings(input) {
        forms.push([...(input.forms ?? [])]);
        return envelope([]);
      },
    };
    const svc = buildService({ usFilings });
    await svc.fetch('AAPL', 'US');

    assert.equal(forms.length, 2);
    assert.ok(forms[0]?.includes('10-K'));
    assert.ok(forms[0]?.includes('DEF 14A'));
    assert.deepEqual(forms[1], ['3', '3/A', '4', '4/A', '5', '5/A']);
  });

  it('CN wiring: CN signals and macro are registered; only optional webSearch stays not configured', async () => {
    const svc = buildService();
    const snap = await svc.fetch('600519', 'CN', { perConnectorTimeoutMs: 100 });
    const notConfigured = snap.dataAvailability.missing
      .filter((m) => m.reason === 'not_configured')
      .map((m) => m.field);
    // CN config has quote / history / profile / financials / filings /
    // consensusEps / lhb / northboundFlow / unlockCalendar / shareholders wired.
    // Tavily is optional when no API key is configured in the test runtime.
    for (const expected of ['webSearch']) {
      assert.ok(
        notConfigured.includes(expected),
        `expected '${expected}' in not_configured set, got [${notConfigured.join(',')}]`,
      );
    }
    // The 5 CN tools + profile + official macro must NOT be in not_configured.
    for (const cnTool of [
      'profile', 'consensusEps', 'lhb', 'northboundFlow', 'unlockCalendar', 'shareholders', 'macro',
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
