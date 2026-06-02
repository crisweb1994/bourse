import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  defineMarketConfig,
  fetchSnapshot,
  portToFetcher,
  snapshotToEvidencePack,
  type MarketConfigMap,
  type StockSnapshot,
  type ToEvidencePackOptions,
} from '@bourse/analysis';
import {
  akshareNorthboundCN,
  consensusEpsCN,
  lhbScanCN,
  shareholdersCN,
  unlockCalendarCN,
  type EvidencePackV2,
  type ToolContext,
  type ToolDescriptor,
} from '@bourse/analysis';
import { getMarket } from '@bourse/analysis';
import type {
  CompanyProfile,
  FilingPort,
  FinancePort,
  FinancialsPort,
} from '@bourse/analysis';
import {
  CN_FILING_PORT,
  CN_FINANCE_PORT,
  CN_FINANCIALS_PORT,
  HK_FINANCIALS_PORT,
  US_FILING_PORT,
  US_FINANCIALS_PORT,
  YAHOO_FINANCE_PORT,
} from '../connectors/connectors.module';

/**
 * plan-v2 Wave 2.3 — apps/api integration surface for the new
 * `analysisPkg.fetchSnapshot` orchestrator.
 *
 * This service:
 *   1. Pulls the existing research-core port singletons out of DI.
 *   2. Wraps them into a static `MarketConfigMap` via `portToFetcher`.
 *   3. Exposes a single async `fetch(symbol, market)` that delegates to
 *      `analysisPkg.fetchSnapshot()`.
 *
 * Shadow-mode safe: nothing on the existing analysis path calls this
 * service yet. Wave 2.4 will route traffic; Wave 2.5 will delete the
 * old planning-backed path.
 *
 * Caller controls:
 *   - perConnectorTimeoutMs (default 8s inside fetchSnapshot)
 *   - historyDays (default 365)
 *   - filingsLimit (default 10)
 *
 * Connector availability follows research-module wiring:
 *   - US: yahoo finance + history + SEC EDGAR filings + SEC XBRL financials
 *   - CN: tencent/eastmoney quote + eastmoney financials + CNInfo filings
 *   - HK: yahoo finance (HK suffix) + eastmoney HK F10 financials
 */
@Injectable()
export class SnapshotV2Service {
  private readonly logger = new Logger(SnapshotV2Service.name);
  private readonly configs: MarketConfigMap;

  constructor(
    @Inject(YAHOO_FINANCE_PORT) private readonly yahoo: FinancePort,
    @Inject(CN_FINANCE_PORT) private readonly cnFinance: FinancePort,
    @Inject(US_FINANCIALS_PORT) private readonly usFinancials: FinancialsPort,
    @Inject(CN_FINANCIALS_PORT) private readonly cnFinancials: FinancialsPort,
    @Inject(HK_FINANCIALS_PORT) private readonly hkFinancials: FinancialsPort,
    @Inject(US_FILING_PORT) private readonly usFilings: FilingPort,
    @Inject(CN_FILING_PORT) private readonly cnFilings: FilingPort,
  ) {
    this.configs = this.buildConfigs();
  }

  /**
   * Fetch a complete StockSnapshot for the given (symbol, market). Pure
   * delegation to analysisPkg.fetchSnapshot with the DI-injected port
   * fetchers; safe to call concurrently.
   */
  /**
   * Wave 2.4 — fetch a snapshot AND project it to an EvidencePackV2.
   * Convenience method for callers (AnalysisService) that want to keep
   * feeding the existing LLM dimension agents with the legacy pack
   * shape. The adapter bridges; nothing on the LLM side changes.
   */
  async fetchAsEvidencePack(
    symbol: string,
    market: 'US' | 'CN' | 'HK',
    options?: ToEvidencePackOptions & {
      perConnectorTimeoutMs?: number;
      historyDays?: number;
      filingsLimit?: number;
      signal?: AbortSignal;
    },
  ): Promise<EvidencePackV2> {
    const snap = await this.fetch(symbol, market, options);
    return snapshotToEvidencePack(snap, {
      planId: options?.planId,
      snapshotId: options?.snapshotId,
    });
  }

  async fetch(
    symbol: string,
    market: 'US' | 'CN' | 'HK',
    options?: {
      perConnectorTimeoutMs?: number;
      historyDays?: number;
      filingsLimit?: number;
      signal?: AbortSignal;
    },
  ): Promise<StockSnapshot> {
    const startedAt = Date.now();
    try {
      const snap = await fetchSnapshot({
        symbol,
        market,
        configs: this.configs,
        perConnectorTimeoutMs: options?.perConnectorTimeoutMs,
        historyDays: options?.historyDays,
        filingsLimit: options?.filingsLimit,
        signal: options?.signal,
      });
      this.logger.debug?.(
        `fetchSnapshot ${market}:${symbol} ok available=${snap.dataAvailability.available.length} missing=${snap.dataAvailability.missing.length} (${Date.now() - startedAt}ms)`,
      );
      return snap;
    } catch (err) {
      this.logger.error(
        `fetchSnapshot ${market}:${symbol} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Config wiring
  // --------------------------------------------------------------------------

  private buildConfigs(): MarketConfigMap {
    // Quote / history come off the FinancePort; financials off the
    // FinancialsPort. We use the same `instrumentId` shape (US:AAPL /
    // CN:600519 / HK:0700) that research-core ports expect.

    const instrumentId = (market: 'US' | 'CN' | 'HK', symbol: string): string =>
      `${market}:${symbol}`;

    return {
      US: defineMarketConfig('US', 'USD', {
        quote: portToFetcher((symbol, ctx) =>
          this.yahoo.getQuote({ instrumentId: instrumentId('US', symbol) }, ctx),
        ),
        history: async (symbol, from, to, ctx) => {
          const env = await this.yahoo.getHistory(
            { instrumentId: instrumentId('US', symbol), from, to, interval: '1d' },
            ctx,
          );
          return env?.data ?? null;
        },
        profile: async (symbol, ctx) => {
          const env = await this.yahoo.getProfile!(
            { instrumentId: instrumentId('US', symbol) },
            ctx,
          );
          return profileEnvelopeToFact(env?.data);
        },
        financials: portToFetcher((symbol, ctx) =>
          this.usFinancials.fetchFinancials(
            { instrumentId: instrumentId('US', symbol) },
            ctx,
          ),
        ),
        filings: async (symbol, limit, ctx) => {
          const env = await this.usFilings.searchFilings(
            { instrumentId: instrumentId('US', symbol), limit },
            ctx,
          );
          return env?.data ?? null;
        },
      }),
      CN: defineMarketConfig('CN', 'CNY', {
        quote: portToFetcher((symbol, ctx) =>
          this.cnFinance.getQuote({ instrumentId: instrumentId('CN', symbol) }, ctx),
        ),
        history: async (symbol, from, to, ctx) => {
          const env = await this.cnFinance.getHistory(
            { instrumentId: instrumentId('CN', symbol), from, to, interval: '1d' },
            ctx,
          );
          return env?.data ?? null;
        },
        profile: async (symbol, ctx) => {
          const env = await this.cnFinance.getProfile!(
            { instrumentId: instrumentId('CN', symbol) },
            ctx,
          );
          return profileEnvelopeToFact(env?.data);
        },
        financials: portToFetcher((symbol, ctx) =>
          this.cnFinancials.fetchFinancials(
            { instrumentId: instrumentId('CN', symbol) },
            ctx,
          ),
        ),
        filings: async (symbol, limit, ctx) => {
          const env = await this.cnFilings.searchFilings(
            { instrumentId: instrumentId('CN', symbol), limit },
            ctx,
          );
          return env?.data ?? null;
        },
        // plan-v2 Wave 2.5 — CN-only fact tools, wired in for parity with
        // the legacy cn-tool-driven-augmenter. All run via the same
        // ToolDescriptor.run() with a minimal ToolContext (signal +
        // CN MarketProfile). Failures are caught by the snapshot
        // orchestrator and surface in dataAvailability with structured
        // reason codes.
        consensusEps: toolToFetcher(consensusEpsCN),
        lhb: toolToFetcher(lhbScanCN),
        northboundFlow: toolToFetcher(akshareNorthboundCN),
        unlockCalendar: toolToFetcher(unlockCalendarCN),
        shareholders: toolToFetcher(shareholdersCN),
      }),
      HK: defineMarketConfig('HK', 'HKD', {
        quote: portToFetcher((symbol, ctx) =>
          this.yahoo.getQuote({ instrumentId: instrumentId('HK', symbol) }, ctx),
        ),
        history: async (symbol, from, to, ctx) => {
          const env = await this.yahoo.getHistory(
            { instrumentId: instrumentId('HK', symbol), from, to, interval: '1d' },
            ctx,
          );
          return env?.data ?? null;
        },
        // HK financials via Eastmoney datacenter HK F10
        // (RPT_HKF10_FN_MAININDICATOR wide report). Reporting currency
        // resolved from RPT_HKF10_FN_INCOME.CURRENCY_CODE (Tencent → CNY).
        financials: portToFetcher((symbol, ctx) =>
          this.hkFinancials.fetchFinancials(
            { instrumentId: instrumentId('HK', symbol) },
            ctx,
          ),
        ),
      }),
    };
  }
}

/**
 * Wrap a CN ToolDescriptor as an ExtraFetcher. The descriptor's `run()`
 * takes (input, ctx); we shape input as `{symbol, market: 'CN'}` and
 * synthesize a minimal ToolContext with the CN MarketProfile + signal.
 *
 * Returns the raw ToolResult.data — fetchSnapshot stores it on
 * RawFacts; the adapter (snapshotToEvidencePack) projects it into the
 * EvidencePackV2 shape.
 *
 * Errors bubble to fetchSnapshot's classifyError path; tool 429s
 * become `rate_limited` via the message regex; .reason='not_implemented'
 * (akshareNorthboundCN's all-mirrors-failed path) becomes
 * `not_implemented`.
 */
function toolToFetcher(
  tool: ToolDescriptor<{ symbol: string; market: 'CN' }, unknown>,
): (symbol: string, ctx?: { signal?: AbortSignal }) => Promise<unknown | null> {
  return async (symbol, ctx) => {
    if (!tool.run) return null;
    const toolCtx: ToolContext = {
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
      ...(getMarket('CN') ? { marketProfile: getMarket('CN')! } : {}),
    };
    const result = await tool.run({ symbol, market: 'CN' }, toolCtx);
    return result?.data ?? null;
  };
}

/**
 * getProfile always returns a `data` object (at minimum the instrument
 * sentinel) even on failure / no-data, so we can't rely on `env.data ?? null`
 * to drive the snapshot's missing/available split. Treat a profile as present
 * only when it carries at least one real descriptive field; otherwise return
 * null so fetchSnapshot records it as `no_data`.
 */
function profileEnvelopeToFact(
  data: CompanyProfile | null | undefined,
): Record<string, unknown> | null {
  if (!data) return null;
  const hasContent =
    Boolean(data.description) ||
    Boolean(data.sector) ||
    Boolean(data.industry) ||
    Boolean(data.website) ||
    typeof data.employees === 'number';
  return hasContent ? (data as unknown as Record<string, unknown>) : null;
}
