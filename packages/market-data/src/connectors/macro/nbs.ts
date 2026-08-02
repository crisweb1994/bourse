import { z } from 'zod';
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { SourceManifest } from '../../contracts/source';
import type { MacroCategory, MacroFrequency, MacroObservation, MacroSnapshot, ProviderMacroPort } from '../../ports/macro';
import type { ConnectorRunContext, FetchLike } from '../types';
import { resolveFetch, withTimeout } from '../http';
import { sourceMacroPort } from '../../sources/provider-port';
import type { SourceInstance, SourcePlugin } from '../../sources/plugin';

const PROVIDER = 'nbs-cn-macro';
const DEFAULT_API_URL = 'https://data.stats.gov.cn/easyquery.htm';

export interface NbsSeriesDefinition {
  seriesCode: string;
  providerSeriesId: string;
  name: string;
  category: MacroCategory;
  unit: string;
  frequency: MacroFrequency;
  seasonalAdjustment?: 'SA' | 'NSA' | 'UNKNOWN';
}

/** Provider ids are isolated here so a catalog revision does not affect canonical codes. */
export const NBS_CN_SERIES: readonly NbsSeriesDefinition[] = [
  { seriesCode: 'CN.CPI.YOY', providerSeriesId: 'A010101', name: 'Consumer price index YoY', category: 'inflation', unit: 'percent', frequency: 'MONTHLY', seasonalAdjustment: 'NSA' },
  { seriesCode: 'CN.PPI.YOY', providerSeriesId: 'A010801', name: 'Producer price index YoY', category: 'inflation', unit: 'percent', frequency: 'MONTHLY', seasonalAdjustment: 'NSA' },
  { seriesCode: 'CN.PMI.MANUFACTURING', providerSeriesId: 'A0B0101', name: 'Manufacturing PMI', category: 'growth', unit: 'index', frequency: 'MONTHLY', seasonalAdjustment: 'SA' },
  { seriesCode: 'CN.INDUSTRIAL_OUTPUT.YOY', providerSeriesId: 'A020A01', name: 'Industrial value added YoY', category: 'growth', unit: 'percent', frequency: 'MONTHLY', seasonalAdjustment: 'NSA' },
  { seriesCode: 'CN.RETAIL_SALES.YOY', providerSeriesId: 'A070101', name: 'Retail sales YoY', category: 'growth', unit: 'percent', frequency: 'MONTHLY', seasonalAdjustment: 'NSA' },
  { seriesCode: 'CN.FIXED_ASSET_INVESTMENT.YOY', providerSeriesId: 'A060101', name: 'Fixed asset investment YoY', category: 'growth', unit: 'percent', frequency: 'MONTHLY', seasonalAdjustment: 'NSA' },
] as const;

export interface NbsMacroSourceConfig {
  enabled?: boolean;
  enabledSeriesCodes?: readonly string[];
  apiUrl?: string;
  timeoutMs?: number;
  fetchLike?: FetchLike;
}

const NbsEnvelopeSchema = z.object({
  returncode: z.union([z.number(), z.string()]).optional(),
  returnmsg: z.string().optional(),
  returndata: z.object({
    datanodes: z.array(z.object({
      code: z.string().optional(),
      data: z.object({ data: z.union([z.string(), z.number()]).nullish(), hasdata: z.boolean().optional() }),
      wds: z.array(z.object({ wdcode: z.string(), valuecode: z.string() })).optional(),
    })),
  }),
});

export function createNbsMacroSourcePlugin(): SourcePlugin<NbsMacroSourceConfig> {
  const manifest = manifestFor(NBS_CN_SERIES);
  return {
    manifest,
    create(config): SourceInstance {
      const enabled = new Set(config.enabledSeriesCodes ?? NBS_CN_SERIES.map((item) => item.seriesCode));
      const definitions = NBS_CN_SERIES.filter((item) => enabled.has(item.seriesCode));
      return {
        manifest: manifestFor(definitions),
        enabled: (config.enabled ?? true) && definitions.length > 0,
        credentialScope: 'public',
        ports: { macro: sourceMacroPort(PROVIDER, createNbsMacroConnector({ ...config, definitions })) },
      };
    },
  };
}

export function createNbsMacroConnector(options: NbsMacroSourceConfig & { definitions?: readonly NbsSeriesDefinition[] } = {}): ProviderMacroPort {
  const definitions = options.definitions ?? NBS_CN_SERIES;
  return {
    async fetchMacro(input, ctx = {}) {
      const requested = new Set(input.seriesCodes ?? definitions.map((item) => item.seriesCode));
      const selected = definitions.filter((item) => requested.has(item.seriesCode) && (!input.categories || input.categories.includes(item.category)));
      const results = await Promise.all(selected.map((definition) => fetchSeries(definition, input.limitPerSeries ?? 24, options, ctx)));
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok) return macroFailure(failed.retrievedAt, failed.code, failed.message);
      const observations = results.flatMap((result) => result.ok ? result.observations : []);
      const retrievedAt = results.find((result) => result.ok)?.retrievedAt ?? new Date().toISOString();
      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: { market: 'CN', observations },
        citations: selected.map((definition) => ({ title: `National Bureau of Statistics: ${definition.name}`, url: 'https://data.stats.gov.cn/', sourceType: 'MACRO' as const, provider: PROVIDER, retrievedAt, qualityTier: 'A' as const })),
        freshness: [{ provider: PROVIDER, asOf: observations[0]?.releasedAt ?? observations[0]?.periodEnd ?? retrievedAt, retrievedAt, stale: false }],
        warnings: [],
      };
    },
  };
}

async function fetchSeries(definition: NbsSeriesDefinition, limit: number, options: NbsMacroSourceConfig, ctx: ConnectorRunContext): Promise<{ ok: true; observations: MacroObservation[]; retrievedAt: string } | { ok: false; code: 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED' | 'INVALID_PAYLOAD'; message: string; retrievedAt: string }> {
  const retrievedAt = new Date().toISOString();
  const params = new URLSearchParams({ m: 'QueryData', dbcode: definition.frequency === 'ANNUAL' ? 'hgnd' : 'hgyd', rowcode: 'sj', colcode: 'zb', wds: '[]', dfwds: JSON.stringify([{ wdcode: 'zb', valuecode: definition.providerSeriesId }]), k1: String(Date.now()), h: '1' });
  const url = `${options.apiUrl?.trim() || DEFAULT_API_URL}?${params.toString()}`;
  try {
    const response = await withTimeout(ctx, ctx.timeoutMs ?? options.timeoutMs ?? 12_000, (signal) => resolveFetch(ctx, options)(url, { headers: { accept: 'application/json', referer: 'https://data.stats.gov.cn/' }, signal }));
    if (!response.ok) return { ok: false, code: response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE', message: `NBS HTTP ${response.status}`, retrievedAt };
    const parsed = NbsEnvelopeSchema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, code: 'INVALID_PAYLOAD', message: 'NBS response schema changed.', retrievedAt };
    if (parsed.data.returncode !== undefined && String(parsed.data.returncode) !== '200') return { ok: false, code: 'SOURCE_UNAVAILABLE', message: parsed.data.returnmsg ?? `NBS return code ${parsed.data.returncode}`, retrievedAt };
    const observations = parsed.data.returndata.datanodes.flatMap((node): MacroObservation[] => {
      if (node.data.hasdata === false || node.data.data === null || node.data.data === undefined) return [];
      const periodCode = node.wds?.find((item) => item.wdcode === 'sj')?.valuecode ?? node.code?.match(/sj\.([^_]+)/)?.[1];
      const period = parsePeriod(periodCode, definition.frequency);
      const value = decimal(node.data.data);
      if (!period || value === undefined) return [];
      return [{ market: 'CN', seriesCode: definition.seriesCode, category: definition.category, name: definition.name, value, unit: definition.unit, frequency: definition.frequency, periodStart: period.start, periodEnd: period.end, seasonalAdjustment: definition.seasonalAdjustment ?? 'UNKNOWN', provider: PROVIDER, providerSeriesId: definition.providerSeriesId }];
    }).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, Math.max(1, limit));
    if (parsed.data.returndata.datanodes.length > 0 && observations.length === 0) return { ok: false, code: 'INVALID_PAYLOAD', message: `NBS ${definition.providerSeriesId} rows could not be normalized.`, retrievedAt };
    return { ok: true, observations, retrievedAt };
  } catch (error) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retrievedAt };
  }
}

function manifestFor(definitions: readonly NbsSeriesDefinition[]): SourceManifest {
  return { id: PROVIDER, name: 'National Bureau of Statistics of China', sourceType: 'official', requiresAuth: false, allowRedistribution: true, capabilities: [{ capability: 'macro', dataSets: ['macro-series'], seriesCodes: definitions.map((item) => item.seriesCode), markets: ['CN'], qualityTier: 'A', authority: 'regulator', ttlMs: 6 * 60 * 60 * 1_000, redistribution: 'public-cache-allowed', transport: 'official-api' }], rateLimit: { maxRequests: 20, windowMs: 60_000, concurrent: 2 } };
}
function macroFailure(retrievedAt: string, code: 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED' | 'INVALID_PAYLOAD', message: string): ResearchResult<MacroSnapshot> { return { schemaVersion: RESEARCH_SCHEMA_VERSION, data: { market: 'CN', observations: [] }, citations: [], freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: message }], warnings: [{ code, message, provider: PROVIDER }] }; }
function decimal(value: unknown): string | undefined { const normalized = String(value).trim().replace(/,/g, ''); return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) ? normalized : undefined; }
function parsePeriod(value: string | undefined, frequency: MacroFrequency): { start: string; end: string } | undefined { if (!value) return undefined; if (frequency === 'MONTHLY') { const match = value.match(/^(\d{4})(\d{2})$/); if (!match) return undefined; const year = Number(match[1]); const month = Number(match[2]); if (month < 1 || month > 12) return undefined; return { start: `${match[1]}-${match[2]}-01`, end: `${match[1]}-${match[2]}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}` }; } const annual = value.match(/^(\d{4})$/); return annual ? { start: `${annual[1]}-01-01`, end: `${annual[1]}-12-31` } : undefined; }
