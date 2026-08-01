import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { SourceManifest } from '../../contracts/source';
import type { MacroCategory, MacroFrequency, MacroObservation, MacroSnapshot, ProviderMacroPort } from '../../ports/macro';
import type { ConnectorRunContext, FetchLike } from '../types';
import { resolveFetch, withTimeout } from '../http';
import { parseCsv } from '../hk/sfc-short-position';
import { sourceMacroPort } from '../../sources/provider-port';
import type { SourceConfig, SourceInstance, SourcePlugin } from '../../sources/plugin';

export interface OfficialMacroFileSeries {
  seriesCode: string;
  providerSeriesId: string;
  name: string;
  category: MacroCategory;
  unit: string;
  frequency: MacroFrequency;
  url: string;
  columns: { period: string; value: string; releasedAt?: string; revisedAt?: string };
  seasonalAdjustment?: 'SA' | 'NSA' | 'UNKNOWN';
}

export interface OfficialMacroFileSourceConfig {
  id: string;
  name: string;
  series: readonly OfficialMacroFileSeries[];
  fetchLike?: FetchLike;
  timeoutMs?: number;
  enabled?: boolean;
}

/** Strict adapter for reviewed PBOC/SAFE official CSV attachments. */
export function createOfficialMacroFileSourcePlugin(source: OfficialMacroFileSourceConfig): SourcePlugin<SourceConfig> {
  const manifest = manifestFor(source);
  return {
    manifest,
    create(config): SourceInstance {
      return {
        manifest,
        enabled: config.enabled ?? source.enabled ?? true,
        credentialScope: 'public',
        ports: { macro: sourceMacroPort(source.id, createOfficialMacroFileConnector(source)) },
      };
    },
  };
}

export function createOfficialMacroFileConnector(source: OfficialMacroFileSourceConfig): ProviderMacroPort {
  return {
    async fetchMacro(input, ctx = {}) {
      const requested = new Set(input.seriesCodes ?? source.series.map((item) => item.seriesCode));
      const definitions = source.series.filter((item) => requested.has(item.seriesCode) && (!input.categories || input.categories.includes(item.category)));
      const results = await Promise.all(definitions.map((definition) => fetchFileSeries(source, definition, input.limitPerSeries ?? input.lookback ?? 24, ctx)));
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok) return failure(source.id, failed.retrievedAt, failed.message);
      const observations = results.flatMap((result) => result.ok ? result.observations : []);
      const retrievedAt = results.find((result) => result.ok)?.retrievedAt ?? new Date().toISOString();
      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: { market: 'CN', observations },
        citations: definitions.map((definition) => ({ title: `${source.name}: ${definition.name}`, url: definition.url, sourceType: 'MACRO' as const, provider: source.id, retrievedAt, qualityTier: 'A' as const })),
        freshness: [{ provider: source.id, asOf: observations[0]?.releasedAt ?? observations[0]?.periodEnd ?? retrievedAt, retrievedAt, stale: false }],
        warnings: [],
      };
    },
  };
}

async function fetchFileSeries(source: OfficialMacroFileSourceConfig, definition: OfficialMacroFileSeries, limit: number, ctx: ConnectorRunContext): Promise<{ ok: true; observations: MacroObservation[]; retrievedAt: string } | { ok: false; message: string; retrievedAt: string }> {
  const retrievedAt = new Date().toISOString();
  try {
    const response = await withTimeout(ctx, ctx.timeoutMs ?? source.timeoutMs ?? 12_000, (signal) => resolveFetch(ctx, source)(definition.url, { headers: { accept: 'text/csv,text/plain,*/*', 'user-agent': 'Bourse open-source research' }, signal }));
    if (!response.ok || !response.text) return { ok: false, message: `${source.name} official file HTTP ${response.status}`, retrievedAt };
    const rows = parseCsv(await response.text());
    if (rows.length < 2) return { ok: false, message: `${source.name} official file is empty or malformed.`, retrievedAt };
    const headers = rows[0]!.map(normalizeHeader);
    const periodIndex = headers.indexOf(normalizeHeader(definition.columns.period));
    const valueIndex = headers.indexOf(normalizeHeader(definition.columns.value));
    const releaseIndex = definition.columns.releasedAt ? headers.indexOf(normalizeHeader(definition.columns.releasedAt)) : -1;
    const revisedIndex = definition.columns.revisedAt ? headers.indexOf(normalizeHeader(definition.columns.revisedAt)) : -1;
    if (periodIndex < 0 || valueIndex < 0 || (definition.columns.releasedAt && releaseIndex < 0) || (definition.columns.revisedAt && revisedIndex < 0)) return { ok: false, message: `${source.name} official file headers changed for ${definition.seriesCode}.`, retrievedAt };
    const observations = rows.slice(1).flatMap((row): MacroObservation[] => {
      const period = parsePeriod(row[periodIndex], definition.frequency);
      const value = decimal(row[valueIndex]);
      if (!period || value === undefined) return [];
      return [{ market: 'CN', seriesCode: definition.seriesCode, category: definition.category, name: definition.name, value, unit: definition.unit, frequency: definition.frequency, periodStart: period.start, periodEnd: period.end, ...(releaseIndex >= 0 && parseDate(row[releaseIndex]) ? { releasedAt: parseDate(row[releaseIndex]) } : {}), ...(revisedIndex >= 0 && parseDate(row[revisedIndex]) ? { revisedAt: parseDate(row[revisedIndex]) } : {}), seasonalAdjustment: definition.seasonalAdjustment ?? 'UNKNOWN', provider: source.id, providerSeriesId: definition.providerSeriesId }];
    }).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, Math.max(1, limit));
    if (rows.length > 1 && observations.length === 0) return { ok: false, message: `${source.name} file rows could not be normalized for ${definition.seriesCode}.`, retrievedAt };
    return { ok: true, observations, retrievedAt };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), retrievedAt };
  }
}

function manifestFor(source: OfficialMacroFileSourceConfig): SourceManifest { return { id: source.id, name: source.name, sourceType: 'official', requiresAuth: false, allowRedistribution: true, capabilities: [{ capability: 'macro', dataSets: ['macro-series'], seriesCodes: source.series.map((item) => item.seriesCode), markets: ['CN'], qualityTier: 'A', authority: 'regulator', ttlMs: 6 * 60 * 60 * 1_000, redistribution: 'public-cache-allowed', transport: 'official-file' }], rateLimit: { maxRequests: 10, windowMs: 60_000, concurrent: 2 } }; }
function failure(provider: string, retrievedAt: string, message: string): ResearchResult<MacroSnapshot> { return { schemaVersion: RESEARCH_SCHEMA_VERSION, data: { market: 'CN', observations: [] }, citations: [], freshness: [{ provider, asOf: retrievedAt, retrievedAt, stale: true, reason: message }], warnings: [{ code: 'INVALID_PAYLOAD', message, provider }] }; }
function normalizeHeader(value: string) { return value.replace(/^\ufeff/, '').trim().toLowerCase().replace(/[\s_\-()（）]/g, ''); }
function decimal(value: string | undefined): string | undefined { const normalized = value?.trim().replace(/[,%\s]/g, ''); return normalized && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) ? normalized : undefined; }
function parseDate(value: string | undefined): string | undefined { if (!value) return undefined; const match = value.trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/); return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}T00:00:00.000Z` : undefined; }
function parsePeriod(value: string | undefined, frequency: MacroFrequency): { start: string; end: string } | undefined { if (!value) return undefined; const raw = value.trim(); if (frequency === 'ANNUAL') { const match = raw.match(/^(\d{4})(?:年)?$/); return match ? { start: `${match[1]}-01-01`, end: `${match[1]}-12-31` } : undefined; } if (frequency === 'QUARTERLY') { const match = raw.match(/^(\d{4})[- ]?[Qq]([1-4])$/); if (!match) return undefined; const quarter = Number(match[2]); const firstMonth = (quarter - 1) * 3 + 1; const lastMonth = quarter * 3; const lastDay = new Date(Date.UTC(Number(match[1]), lastMonth, 0)).getUTCDate(); return { start: `${match[1]}-${String(firstMonth).padStart(2, '0')}-01`, end: `${match[1]}-${String(lastMonth).padStart(2, '0')}-${lastDay}` }; } if (frequency === 'MONTHLY') { const match = raw.match(/^(\d{4})[-/.年]?(\d{1,2})(?:月)?$/); if (!match) return undefined; const month = Number(match[2]); if (month < 1 || month > 12) return undefined; const lastDay = new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate(); return { start: `${match[1]}-${String(month).padStart(2, '0')}-01`, end: `${match[1]}-${String(month).padStart(2, '0')}-${lastDay}` }; } const date = parseDate(raw); return date ? { start: date.slice(0, 10), end: date.slice(0, 10) } : undefined; }
