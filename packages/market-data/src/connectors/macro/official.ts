import type { DataFreshness } from '../../contracts/freshness';
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import { resolveFetch, withTimeout } from '../http';
import type { ConnectorRunContext, FetchLike } from '../types';
import type {
  MacroIndicator,
  MacroMarket,
  MacroObservation,
  ProviderMacroPort as MacroPort,
  MacroSnapshot,
} from '../../ports/macro';

const WORLD_BANK_BASE = 'https://api.worldbank.org/v2/country';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const US_TREASURY_DEBT =
  'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny';
const HKMA_BASE =
  'https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir';
const DEFAULT_TIMEOUT_MS = 8_000;

interface SeriesOutcome {
  observations: MacroObservation[];
  citations: ResearchCitation[];
  warnings: ResearchWarning[];
}

interface WorldBankSpec {
  indicator: Extract<MacroIndicator, 'gdp_growth' | 'inflation' | 'unemployment'>;
  id: string;
  title: string;
}

const WORLD_BANK_SERIES: readonly WorldBankSpec[] = [
  { indicator: 'gdp_growth', id: 'NY.GDP.MKTP.KD.ZG', title: 'GDP growth (annual %)' },
  { indicator: 'inflation', id: 'FP.CPI.TOTL.ZG', title: 'Inflation, consumer prices (annual %)' },
  { indicator: 'unemployment', id: 'SL.UEM.TOTL.ZS', title: 'Unemployment, total (% of labor force)' },
];

/**
 * Small, key-free macro connector for the three markets currently supported
 * by SnapshotV2. It intentionally covers stable official endpoints only;
 * missing series become structured warnings instead of failing an analysis.
 */
export function createOfficialMacroConnector(
  options: OfficialMacroOptions = {},
): MacroPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  return {
    async fetchMacro(input, ctx: ConnectorRunContext = {}): Promise<ResearchResult<MacroSnapshot>> {
      const retrievedAt = now().toISOString();
      const lookback = Math.max(1, Math.min(3, Math.trunc(input.lookback ?? 1)));
      const fetchLike = resolveFetch(ctx, options);
      const tasks: Promise<SeriesOutcome>[] = WORLD_BANK_SERIES.map((series) =>
        fetchWorldBank(input.market, series, lookback, retrievedAt, fetchLike, timeoutMs, ctx),
      );

      if (input.market === 'US') {
        tasks.push(
          fetchFred('policy_rate', 'FEDFUNDS', 'Effective Federal Funds Rate', 'MONTHLY', lookback, retrievedAt, fetchLike, timeoutMs, ctx),
          fetchFred('government_bond_10y', 'DGS10', '10-Year Treasury Constant Maturity Rate', 'DAILY', lookback, retrievedAt, fetchLike, timeoutMs, ctx),
          fetchUsTreasuryDebt(lookback, retrievedAt, fetchLike, timeoutMs, ctx),
        );
      }
      if (input.market === 'HK') {
        tasks.push(
          fetchHkma('exchange_rate', 'er-eeri-daily', 'usd', 'HKD per USD', 'local_currency_per_usd', lookback, retrievedAt, fetchLike, timeoutMs, ctx),
          fetchHkma('interbank_rate_3m', 'hk-interbank-ir-daily', 'ir_3m', '3-month HIBOR', 'percent', lookback, retrievedAt, fetchLike, timeoutMs, ctx),
        );
      }

      const outcomes = await Promise.all(tasks);
      const observations = outcomes
        .flatMap((outcome) => outcome.observations)
        .sort((a, b) => a.indicator.localeCompare(b.indicator) || b.period.localeCompare(a.period));
      const warnings = outcomes.flatMap((outcome) => outcome.warnings);
      const citations = dedupeCitations(outcomes.flatMap((outcome) => outcome.citations));
      const freshness = buildFreshness(observations, retrievedAt);

      for (const item of freshness) {
        if (item.stale) {
          warnings.push({
            code: 'STALE_DATA',
            message: item.reason ?? `${item.provider} macro data is stale`,
            provider: item.provider,
            sourceType: 'MACRO',
          });
        }
      }

      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: { market: input.market, observations },
        citations,
        freshness,
        warnings,
      };
    },
  };
}

async function fetchUsTreasuryDebt(
  lookback: number,
  retrievedAt: string,
  fetchLike: FetchLike,
  timeoutMs: number,
  ctx: ConnectorRunContext,
): Promise<SeriesOutcome> {
  const seriesId = 'debt_to_penny:tot_pub_debt_out_amt';
  const query = new URLSearchParams({
    sort: '-record_date',
    'page[size]': String(lookback),
    format: 'json',
  });
  try {
    return await withTimeout(ctx, timeoutMs, async (signal) => {
      const response = await fetchLike(`${US_TREASURY_DEBT}?${query.toString()}`, {
        headers: { Accept: 'application/json' }, signal,
      });
      if (!response.ok) return failed('us-treasury', seriesId, `HTTP ${response.status}`);
      const payload = await response.json() as { data?: unknown };
      const rows = Array.isArray(payload.data) ? payload.data : [];
      const observations = rows.flatMap((row): MacroObservation[] => {
        if (!row || typeof row !== 'object') return [];
        const record = row as Record<string, unknown>;
        const period = record.record_date;
        const value = finite(record.tot_pub_debt_out_amt);
        if (typeof period !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(period) || value === null) return [];
        return [{
          indicator: 'federal_debt',
          value,
          unit: 'usd',
          period,
          frequency: 'DAILY',
          provider: 'us-treasury',
          seriesId,
        }];
      }).sort((a, b) => b.period.localeCompare(a.period)).slice(0, lookback);
      if (observations.length === 0) {
        return failed('us-treasury', seriesId, 'no usable observations', 'PARTIAL_DATA');
      }
      return {
        observations,
        citations: [{
          title: 'US Treasury Fiscal Data: Debt to the Penny',
          url: 'https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/debt-to-the-penny',
          sourceType: 'MACRO',
          provider: 'us-treasury',
          retrievedAt,
          qualityTier: 'A',
        }],
        warnings: [],
      };
    });
  } catch (error) {
    return failed('us-treasury', seriesId, messageOf(error));
  }
}

export interface OfficialMacroOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

async function fetchWorldBank(
  market: MacroMarket,
  series: WorldBankSpec,
  lookback: number,
  retrievedAt: string,
  fetchLike: FetchLike,
  timeoutMs: number,
  ctx: ConnectorRunContext,
): Promise<SeriesOutcome> {
  const url = `${WORLD_BANK_BASE}/${market}/indicator/${series.id}?format=json&per_page=${Math.max(5, lookback * 3)}`;
  try {
    return await withTimeout(ctx, timeoutMs, async (signal) => {
      const response = await fetchLike(url, { headers: { Accept: 'application/json' }, signal });
      if (!response.ok) return failed('world-bank', series.id, `HTTP ${response.status}`);
      const payload = await response.json();
      const rows = Array.isArray(payload) && Array.isArray(payload[1]) ? payload[1] : [];
      const observations = rows
        .flatMap((row): MacroObservation[] => {
          if (!row || typeof row !== 'object') return [];
          const value = finite((row as { value?: unknown }).value);
          const period = (row as { date?: unknown }).date;
          if (value === null || typeof period !== 'string' || !/^\d{4}$/.test(period)) return [];
          return [{
            indicator: series.indicator,
            value,
            unit: 'percent',
            period,
            frequency: 'ANNUAL',
            provider: 'world-bank',
            seriesId: series.id,
          }];
        })
        .sort((a, b) => b.period.localeCompare(a.period))
        .slice(0, lookback);
      if (observations.length === 0) return failed('world-bank', series.id, 'no usable observations', 'PARTIAL_DATA');
      return {
        observations,
        citations: [{
          title: `World Bank: ${series.title}`,
          url: `https://data.worldbank.org/indicator/${series.id}?locations=${market}`,
          sourceType: 'MACRO',
          provider: 'world-bank',
          retrievedAt,
          qualityTier: 'A',
        }],
        warnings: [],
      };
    });
  } catch (error) {
    return failed('world-bank', series.id, messageOf(error));
  }
}

async function fetchFred(
  indicator: Extract<MacroIndicator, 'policy_rate' | 'government_bond_10y'>,
  id: string,
  title: string,
  frequency: 'DAILY' | 'MONTHLY',
  lookback: number,
  retrievedAt: string,
  fetchLike: FetchLike,
  timeoutMs: number,
  ctx: ConnectorRunContext,
): Promise<SeriesOutcome> {
  try {
    return await withTimeout(ctx, timeoutMs, async (signal) => {
      const response = await fetchLike(`${FRED_CSV}?id=${encodeURIComponent(id)}`, {
        headers: { Accept: 'text/csv' }, signal,
      });
      if (!response.ok || !response.text) return failed('fred', id, `HTTP ${response.status}`);
      const csv = await response.text();
      const observations = csv.split(/\r?\n/).slice(1).flatMap((line): MacroObservation[] => {
        const comma = line.indexOf(',');
        if (comma < 0) return [];
        const period = line.slice(0, comma).replaceAll('"', '').trim();
        const value = finite(line.slice(comma + 1).replaceAll('"', '').trim());
        if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(period)) return [];
        return [{ indicator, value, unit: 'percent', period, frequency, provider: 'fred', seriesId: id }];
      }).sort((a, b) => b.period.localeCompare(a.period)).slice(0, lookback);
      if (observations.length === 0) return failed('fred', id, 'no usable observations', 'PARTIAL_DATA');
      return {
        observations,
        citations: [{
          title: `FRED: ${title}`,
          url: `https://fred.stlouisfed.org/series/${id}`,
          sourceType: 'MACRO', provider: 'fred', retrievedAt, qualityTier: 'A',
        }],
        warnings: [],
      };
    });
  } catch (error) {
    return failed('fred', id, messageOf(error));
  }
}

async function fetchHkma(
  indicator: Extract<MacroIndicator, 'exchange_rate' | 'interbank_rate_3m'>,
  endpoint: 'er-eeri-daily' | 'hk-interbank-ir-daily',
  field: 'usd' | 'ir_3m',
  title: string,
  unit: 'percent' | 'local_currency_per_usd',
  lookback: number,
  retrievedAt: string,
  fetchLike: FetchLike,
  timeoutMs: number,
  ctx: ConnectorRunContext,
): Promise<SeriesOutcome> {
  try {
    return await withTimeout(ctx, timeoutMs, async (signal) => {
      const response = await fetchLike(`${HKMA_BASE}/${endpoint}?offset=0`, {
        headers: { Accept: 'application/json' }, signal,
      });
      if (!response.ok) return failed('hkma', endpoint, `HTTP ${response.status}`);
      const payload = await response.json() as {
        header?: { success?: unknown };
        result?: { records?: unknown };
      };
      const records = payload.header?.success === true && Array.isArray(payload.result?.records)
        ? payload.result.records
        : [];
      const observations = records.flatMap((record): MacroObservation[] => {
        if (!record || typeof record !== 'object') return [];
        const row = record as Record<string, unknown>;
        const period = row.end_of_day;
        const value = finite(row[field]);
        if (typeof period !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(period) || value === null) return [];
        return [{ indicator, value, unit, period, frequency: 'DAILY', provider: 'hkma', seriesId: endpoint }];
      }).sort((a, b) => b.period.localeCompare(a.period)).slice(0, lookback);
      if (observations.length === 0) return failed('hkma', endpoint, 'no usable observations', 'PARTIAL_DATA');
      return {
        observations,
        citations: [{
          title: `HKMA: ${title}`,
          url: `https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/er-ir/${endpoint}/`,
          sourceType: 'MACRO', provider: 'hkma', retrievedAt, qualityTier: 'A',
        }],
        warnings: [],
      };
    });
  } catch (error) {
    return failed('hkma', endpoint, messageOf(error));
  }
}

function failed(
  provider: MacroObservation['provider'],
  seriesId: string,
  detail: string,
  code: ResearchWarning['code'] = 'SOURCE_UNAVAILABLE',
): SeriesOutcome {
  return {
    observations: [],
    citations: [],
    warnings: [{
      code,
      message: `${provider} series ${seriesId}: ${detail}`,
      provider,
      sourceType: 'MACRO',
    }],
  };
}

function buildFreshness(observations: MacroObservation[], retrievedAt: string): DataFreshness[] {
  const latestByProvider = new Map<string, MacroObservation>();
  for (const observation of observations) {
    const current = latestByProvider.get(observation.provider);
    if (!current || observation.period > current.period) latestByProvider.set(observation.provider, observation);
  }
  return [...latestByProvider.entries()].map(([provider, latest]) => {
    const asOf = latest.frequency === 'ANNUAL'
      ? `${latest.period}-12-31T23:59:59.999Z`
      : `${latest.period}T00:00:00.000Z`;
    const ttlMs = latest.frequency === 'DAILY'
      ? 45 * 24 * 60 * 60_000
      : latest.frequency === 'MONTHLY'
        ? 90 * 24 * 60 * 60_000
        : 730 * 24 * 60 * 60_000;
    const stale = Date.parse(retrievedAt) - Date.parse(asOf) > ttlMs;
    return {
      provider,
      asOf,
      retrievedAt,
      stale,
      ttlMs,
      ...(stale ? { reason: `latest observation ${latest.period} exceeds freshness window` } : {}),
    };
  });
}

function finite(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dedupeCitations(citations: ResearchCitation[]): ResearchCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citation.url ?? `${citation.provider}:${citation.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}
