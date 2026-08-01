import type { InstrumentRef } from '../../contracts/instrument';
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchWarning } from '../../contracts/warning';
import type {
  CompanyProfile,
  ProviderCompanyProfilePort as CompanyProfilePort,
  ProfileInput,
} from '../../ports/finance';
import { parseInstrumentId } from '../../util/instrument-id';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';
import type { ConnectorRunContext, FetchLike } from '../types';

const PROVIDER = 'eastmoney-hk-profile';
const BASE_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const DEFAULT_TIMEOUT_MS = 8_000;

const HEADERS: Record<string, string> = {
  Referer: 'http://f10.eastmoney.com/',
  'User-Agent': 'Mozilla/5.0',
  Accept: 'application/json, text/plain, */*',
};

interface EastmoneyHkProfileRow {
  BELONG_INDUSTRY?: unknown;
  EMP_NUM?: unknown;
  ORG_PROFILE?: unknown;
  ORG_WEB?: unknown;
}

interface EastmoneyResponse {
  code?: number;
  message?: string;
  result?: { data?: unknown } | null;
}

export interface EastmoneyHkProfileOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

/** Key-free HK company profile fallback for Yahoo's crumb-protected endpoint. */
export function createEastmoneyHkProfileConnector(
  options: EastmoneyHkProfileOptions = {},
): CompanyProfilePort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  return {
    async getProfile(
      input: ProfileInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<CompanyProfile>> {
      const retrievedAt = now().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed || parsed.market !== 'HK') {
        return failure(
          emptyProfile(parsed?.raw ?? input.instrumentId),
          retrievedAt,
          parsed ? 'UNSUPPORTED_MARKET' : 'INVALID_INSTRUMENT',
          parsed
            ? `Eastmoney HK profile does not support ${parsed.market}.`
            : `Invalid instrumentId: ${input.instrumentId}`,
        );
      }

      const secucode = ctx.resolvedInstrument?.instrumentId === parsed.raw
        ? ctx.resolvedInstrument.providerSymbol
        : `${normalizeHkSymbol(parsed.symbol)}.HK`;
      const url = profileUrl(secucode);
      const fetchLike = resolveFetch(ctx, options);

      try {
        return await withTimeout(ctx, ctx.timeoutMs ?? timeoutMs, async (signal) => {
          const response = await fetchLike(url, { headers: HEADERS, signal });
          if (!response.ok) {
            return failure(
              emptyProfile(parsed.raw),
              retrievedAt,
              response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE',
              `Eastmoney HK profile HTTP ${response.status}`,
            );
          }

          const body = (await response.json()) as EastmoneyResponse;
          if (body.code === 9501) {
            return failure(
              emptyProfile(parsed.raw),
              retrievedAt,
              'SOURCE_UNAVAILABLE',
              `Eastmoney HK profile report unavailable: ${body.message ?? 'unknown error'}`,
            );
          }
          const rows = body.result?.data;
          if (!Array.isArray(rows) || rows.length === 0) {
            return failure(
              emptyProfile(parsed.raw),
              retrievedAt,
              'PARTIAL_DATA',
              `Eastmoney HK profile has no row for ${secucode}.`,
            );
          }

          const row = rows[0] as EastmoneyHkProfileRow;
          const description = stringValue(row.ORG_PROFILE);
          const industry = stringValue(row.BELONG_INDUSTRY);
          const website = stringValue(row.ORG_WEB);
          const employees = nonNegativeInteger(row.EMP_NUM);
          const profile: CompanyProfile = {
            instrument: instrument(parsed.raw, parsed.symbol, secucode),
            ...(description ? { description } : {}),
            ...(industry ? { industry } : {}),
            ...(website ? { website } : {}),
            ...(employees !== undefined ? { employees } : {}),
          };

          if (!description && !industry && !website && employees === undefined) {
            return failure(
              profile,
              retrievedAt,
              'PARTIAL_DATA',
              `Eastmoney HK profile row has no usable fields for ${secucode}.`,
            );
          }

          return {
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            data: profile,
            citations: [{
              title: `Eastmoney HK company profile: ${secucode}`,
              url: `http://f10.eastmoney.com/PC_HKF10/pages/home/index.html?code=${normalizeHkSymbol(parsed.symbol)}#/CompanyProfile`,
              sourceType: 'OTHER',
              provider: PROVIDER,
              retrievedAt,
              qualityTier: 'B',
            }],
            freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
            warnings: [],
          };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          emptyProfile(parsed.raw),
          retrievedAt,
          'SOURCE_UNAVAILABLE',
          `Eastmoney HK profile fetch failed: ${message}`,
        );
      }
    },
  };
}

function profileUrl(secucode: string): string {
  const params = new URLSearchParams({
    reportName: 'RPT_HKF10_INFO_ORGPROFILE',
    columns: 'SECUCODE,SECURITY_CODE,ORG_NAME,ORG_EN_ABBR,BELONG_INDUSTRY,EMP_NUM,ORG_WEB,ORG_PROFILE',
    filter: `(SECUCODE="${secucode}")`,
    pageNumber: '1',
    pageSize: '1',
  });
  return `${BASE_URL}?${params.toString()}`;
}

function normalizeHkSymbol(symbol: string): string {
  const digits = symbol.replace(/\.HK$/i, '').trim();
  return /^\d+$/.test(digits) ? digits.padStart(5, '0') : digits;
}

function instrument(instrumentId: string, symbol: string, secucode: string): InstrumentRef {
  return {
    instrumentId,
    market: 'HK',
    symbol,
    currency: 'HKD',
    providerSymbols: { eastmoney: secucode },
  };
}

function emptyProfile(instrumentId: string): CompanyProfile {
  const symbol = instrumentId.split(':').at(-1) ?? instrumentId;
  return { instrument: instrument(instrumentId, symbol, `${normalizeHkSymbol(symbol)}.HK`) };
}

function failure(
  data: CompanyProfile,
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<CompanyProfile> {
  return httpFailure(PROVIDER, data, { retrievedAt, code, message });
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== '-' && trimmed.toLowerCase() !== 'null' ? trimmed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined;
}
