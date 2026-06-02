/**
 * plan-v2 Wave 0 — fixture vendoring CLI.
 *
 * Usage:
 *   pnpm -F @bourse/analysis tsx src/evals/vendor-fixture.ts \
 *     --symbol AAPL --market US [--category mature_large_cap] [--lock]
 *
 * Hits live connectors (Yahoo v8/chart, SEC EDGAR XBRL, Tencent quote,
 * Eastmoney datacenter, etc.) and saves a `RawFixture` JSON. With
 * `--lock`, also writes the matching expected file (locked computed
 * outputs for regression).
 *
 * IMPORTANT: this script makes real network calls. Run sparingly to
 * avoid rate limits. Re-vendor when you intentionally want fresh data.
 */

/* eslint-disable no-console */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCnFinanceConnector } from '../connectors/finance/cn';
import { createYahooFinanceConnector } from '../connectors/finance/yahoo';
import { createEastmoneyFinancialsConnector } from '../connectors/financials/eastmoney';
import { createSecEdgarXbrlFinancialsConnector } from '../connectors/financials/sec-edgar-xbrl';
import type { FinancePort } from '../ports/finance';
import type { FinancialsPort } from '../ports/financials';
import {
  fetchSnapshot,
  defineMarketConfig,
  portToFetcher,
  type MarketConfigMap,
} from '../index';
import { lockExpected } from './judge';
import type { FixtureMeta, RawFixture } from './types';

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

interface CliArgs {
  symbol: string;
  market: 'US' | 'CN' | 'HK';
  category?: FixtureMeta['category'];
  description?: string;
  lock: boolean;
  outDir?: string;
  perConnectorTimeoutMs?: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Partial<CliArgs> = { lock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case '--symbol':
        args.symbol = next; i++; break;
      case '--market':
        args.market = next as CliArgs['market']; i++; break;
      case '--category':
        args.category = next as FixtureMeta['category']; i++; break;
      case '--description':
        args.description = next; i++; break;
      case '--out':
        args.outDir = next; i++; break;
      case '--timeout':
        args.perConnectorTimeoutMs = Number(next); i++; break;
      case '--lock':
        args.lock = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    }
  }
  if (!args.symbol || !args.market) {
    throw new Error('missing required: --symbol --market');
  }
  return args as CliArgs;
}

// ----------------------------------------------------------------------------
// Build a MarketConfig from live connectors (no DI; standalone)
// ----------------------------------------------------------------------------

function buildLiveConfigs(): MarketConfigMap {
  const yahoo: FinancePort = createYahooFinanceConnector();
  const cnFinance: FinancePort = createCnFinanceConnector();
  const userAgent =
    process.env.RESEARCH_CORE_USER_AGENT?.trim() ||
    'stock-suggest-eval contact@example.com';
  const usFinancials: FinancialsPort = createSecEdgarXbrlFinancialsConnector({ userAgent });
  const cnFinancials: FinancialsPort = createEastmoneyFinancialsConnector();

  const id = (m: 'US' | 'CN' | 'HK', s: string) => `${m}:${s}`;

  return {
    US: defineMarketConfig('US', 'USD', {
      quote: portToFetcher((symbol, ctx) =>
        yahoo.getQuote({ instrumentId: id('US', symbol) }, ctx),
      ),
      history: async (symbol, from, to, ctx) => {
        const env = await yahoo.getHistory(
          { instrumentId: id('US', symbol), from, to, interval: '1d' },
          ctx,
        );
        return env?.data ?? null;
      },
      financials: portToFetcher((symbol, ctx) =>
        usFinancials.fetchFinancials({ instrumentId: id('US', symbol) }, ctx),
      ),
    }),
    CN: defineMarketConfig('CN', 'CNY', {
      quote: portToFetcher((symbol, ctx) =>
        cnFinance.getQuote({ instrumentId: id('CN', symbol) }, ctx),
      ),
      history: async (symbol, from, to, ctx) => {
        const env = await cnFinance.getHistory(
          { instrumentId: id('CN', symbol), from, to, interval: '1d' },
          ctx,
        );
        return env?.data ?? null;
      },
      financials: portToFetcher((symbol, ctx) =>
        cnFinancials.fetchFinancials({ instrumentId: id('CN', symbol) }, ctx),
      ),
    }),
    HK: defineMarketConfig('HK', 'HKD', {
      quote: portToFetcher((symbol, ctx) =>
        yahoo.getQuote({ instrumentId: id('HK', symbol) }, ctx),
      ),
      history: async (symbol, from, to, ctx) => {
        const env = await yahoo.getHistory(
          { instrumentId: id('HK', symbol), from, to, interval: '1d' },
          ctx,
        );
        return env?.data ?? null;
      },
    }),
  };
}

// ----------------------------------------------------------------------------
// Vendor
// ----------------------------------------------------------------------------

async function vendor(args: CliArgs): Promise<void> {
  console.log(`[vendor] ${args.market}:${args.symbol} timeout=${args.perConnectorTimeoutMs ?? 'default'}`);
  const startedAt = Date.now();
  const configs = buildLiveConfigs();
  const snap = await fetchSnapshot({
    symbol: args.symbol,
    market: args.market,
    configs,
    ...(args.perConnectorTimeoutMs ? { perConnectorTimeoutMs: args.perConnectorTimeoutMs } : {}),
  });
  console.log(
    `[vendor] fetched in ${Date.now() - startedAt}ms — ` +
      `available=[${snap.dataAvailability.available.join(',')}] ` +
      `missing=${snap.dataAvailability.missing.length}`,
  );

  // Build fixture (strip computedFacts — judge replays them from rawFacts)
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const id = `${args.market}_${args.symbol}_${dateStr}`;
  const fixture: RawFixture = {
    meta: {
      id,
      symbol: args.symbol,
      market: args.market,
      vendoredAt: new Date().toISOString(),
      description: args.description ?? `${args.market} ${args.symbol} live vendor`,
      ...(args.category ? { category: args.category } : {}),
    },
    rawFacts: snap.rawFacts as unknown as Record<string, unknown>,
    citations: snap.citations,
    dataAvailability: snap.dataAvailability,
  };

  // Write to disk
  const baseDir =
    args.outDir ??
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  mkdirSync(baseDir, { recursive: true });
  const fixturePath = join(baseDir, `${id}.json`);
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  console.log(`[vendor] wrote ${fixturePath}`);

  if (args.lock) {
    const expected = lockExpected(fixture);
    const expectedDir = join(dirname(fileURLToPath(import.meta.url)), 'expected');
    mkdirSync(expectedDir, { recursive: true });
    const expectedPath = join(expectedDir, `${id}.json`);
    writeFileSync(expectedPath, JSON.stringify(expected, null, 2));
    console.log(`[vendor] locked ${expectedPath} (hash=${expected.rawHash})`);
    console.log(
      `[vendor] compute summary: ratios=${expected.computedFacts.ratios ? 'yes' : 'no'} ` +
        `tech=${expected.computedFacts.technicalIndicators ? 'yes' : 'no'} ` +
        `flags=${expected.computedFacts.redFlagsCount} ` +
        `valuation=${expected.computedFacts.valuation ? 'yes' : 'no'}`,
    );
  }
}

// ----------------------------------------------------------------------------

vendor(parseArgs(process.argv.slice(2))).catch((err) => {
  console.error('[vendor] error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
