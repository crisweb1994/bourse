import { createHash } from 'node:crypto';
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { OwnershipObservation, OwnershipInput, ProviderOwnershipPort } from '../../ports/ownership';
import type { ConnectorRunContext, FetchLike } from '../types';
import { resolveFetch, withTimeout } from '../http';
import { parseInstrumentId } from '../../util/instrument-id';

const PROVIDER = 'sfc-short-position';

export interface SfcShortPositionOptions {
  csvUrl?: string;
  fetchLike?: FetchLike;
  timeoutMs?: number;
}

export function createSfcShortPositionConnector(options: SfcShortPositionOptions = {}): ProviderOwnershipPort {
  return {
    async listOwnership(input, ctx = {}) {
      const retrievedAt = new Date().toISOString();
      if (input.dataSet !== 'short-position') return failure(input, retrievedAt, 'PARTIAL_DATA', `Unsupported SFC dataset: ${input.dataSet}`);
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed || parsed.market !== 'HK' || !/^\d+$/.test(parsed.symbol)) return failure(input, retrievedAt, 'INVALID_INSTRUMENT', 'SFC short positions require a canonical HK stock code.');
      const url = options.csvUrl?.trim();
      if (!url) return failure(input, retrievedAt, 'CONFIG_MISSING', 'SFC CSV URL must be configured after reviewing the current official download link.');
      try {
        const response = await withTimeout(ctx, ctx.timeoutMs ?? options.timeoutMs ?? 12_000, (signal) =>
          resolveFetch(ctx, options)(url, { headers: { accept: 'text/csv,*/*', 'user-agent': 'Bourse open-source research' }, signal }),
        );
        if (!response.ok || !response.text) return failure(input, retrievedAt, response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE', `SFC CSV HTTP ${response.status}`);
        const rows = parseCsv(await response.text());
        if (rows.length < 2) return failure(input, retrievedAt, 'INVALID_PAYLOAD', 'SFC CSV is empty or malformed.');
        const header = rows[0]!.map(normalizeHeader);
        const indexes = {
          date: findColumn(header, ['reportingdate', 'date']),
          code: findColumn(header, ['stockcode', 'code']),
          shares: findColumn(header, ['aggregatedshortposition', 'shortpositionshares', 'shares']),
          value: findColumn(header, ['aggregatedshortpositionvalue', 'shortpositionvalue', 'value']),
        };
        if (indexes.date < 0 || indexes.code < 0 || indexes.shares < 0) return failure(input, retrievedAt, 'INVALID_PAYLOAD', 'SFC CSV headers changed.');
        const wanted = String(Number(parsed.symbol));
        const observations = rows.slice(1).flatMap((row): OwnershipObservation[] => {
          const code = String(Number((row[indexes.code] ?? '').replace(/[^0-9]/g, '')));
          const asOf = toIsoDate(row[indexes.date]);
          const shares = decimal(row[indexes.shares]);
          if (code !== wanted || !asOf || shares === undefined) return [];
          return [{
            id: `${PROVIDER}:${createHash('sha1').update(`${code}:${asOf}`).digest('hex').slice(0, 16)}`,
            instrumentId: input.instrumentId,
            kind: 'SHORT_POSITION',
            asOf,
            direction: 'SHORT',
            value: shares,
            unit: 'shares',
            periodEnd: asOf.slice(0, 10),
            sourceDocumentId: `sfc-short:${code}:${asOf.slice(0, 10)}`,
          }];
        }).slice(0, input.limit ?? 100);
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: observations,
          citations: [{ title: 'SFC aggregated short position by stock', url, sourceType: 'OTHER', provider: PROVIDER, publishedAt: observations[0]?.asOf, retrievedAt, qualityTier: 'A' }],
          freshness: [{ provider: PROVIDER, asOf: observations[0]?.asOf ?? retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
      } catch (error) {
        return failure(input, retrievedAt, 'SOURCE_UNAVAILABLE', error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted && char === '"' && text[index + 1] === '"') { field += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === ',') { row.push(field.trim()); field = ''; continue; }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field.trim()); field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); }
  return rows;
}

function failure(input: OwnershipInput, retrievedAt: string, code: 'PARTIAL_DATA' | 'INVALID_INSTRUMENT' | 'RATE_LIMITED' | 'SOURCE_UNAVAILABLE' | 'INVALID_PAYLOAD' | 'CONFIG_MISSING', message: string): ResearchResult<OwnershipObservation[]> {
  return { schemaVersion: RESEARCH_SCHEMA_VERSION, data: [], citations: [], freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: message }], warnings: [{ code, message, provider: PROVIDER, cause: input.instrumentId }] };
}
function normalizeHeader(value: string) { return value.replace(/^\ufeff/, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function findColumn(header: string[], candidates: string[]) { return header.findIndex((value) => candidates.some((candidate) => value.includes(candidate))); }
function decimal(value: string | undefined): string | undefined { const normalized = value?.replace(/[,$%\s]/g, ''); if (!normalized || !/^-?\d+(?:\.\d+)?$/.test(normalized)) return undefined; return String(Number(normalized)); }
function toIsoDate(value: string | undefined): string | undefined { if (!value) return undefined; const iso = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/); if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}T00:00:00.000Z`; const dmy = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); return dmy ? `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}T00:00:00.000Z` : undefined; }
