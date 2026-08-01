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
import {
  createInMemoryCikLookup,
  type CikLookup,
} from '../filings/cik-lookup';

const PROVIDER = 'sec-edgar-profile';
const SUBMISSIONS_URL = 'https://data.sec.gov/submissions';
const DEFAULT_TIMEOUT_MS = 8_000;

interface SecSubmissionsProfile {
  name?: string;
  sic?: string;
  sicDescription?: string;
  entityType?: string;
}

export interface SecEdgarProfileOptions {
  userAgent: string;
  cikLookup?: CikLookup;
  fetchLike?: FetchLike;
  timeoutMs?: number;
}

/**
 * Key-free SEC fallback for US company identity and SIC classification.
 * It deliberately does not invent a commercial description or employee count;
 * SnapshotV2 uses it only after Yahoo's richer profile is unavailable.
 */
export function createSecEdgarProfileConnector(
  options: SecEdgarProfileOptions,
): CompanyProfilePort {
  if (!options.userAgent?.trim()) {
    throw new Error('SEC EDGAR profile connector requires a non-empty userAgent.');
  }
  const cikLookup = options.cikLookup ?? createInMemoryCikLookup({
    userAgent: options.userAgent,
    ...(options.fetchLike ? { fetchLike: options.fetchLike } : {}),
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async getProfile(
      input: ProfileInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<CompanyProfile>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed || parsed.market !== 'US') {
        return failure(
          emptyProfile(parsed?.raw ?? input.instrumentId),
          retrievedAt,
          'UNSUPPORTED_MARKET',
          'SEC profile fallback supports US issuers only.',
        );
      }
      const providerSymbol = ctx.resolvedInstrument?.instrumentId === parsed.raw
        ? ctx.resolvedInstrument.providerSymbol
        : parsed.symbol;

      let cik: { cik: string; name: string } | null;
      try {
        cik = await cikLookup.resolve(providerSymbol, ctx);
      } catch (error) {
        return failure(
          emptyProfile(parsed.raw),
          retrievedAt,
          'SOURCE_UNAVAILABLE',
          `SEC CIK lookup failed: ${messageOf(error)}`,
        );
      }
      if (!cik) {
        return failure(
          emptyProfile(parsed.raw),
          retrievedAt,
          'INVALID_INSTRUMENT',
          `Unknown SEC ticker: ${parsed.symbol}`,
        );
      }

      const fetchLike = resolveFetch(ctx, options);
      try {
        return await withTimeout(ctx, ctx.timeoutMs ?? timeoutMs, async (signal) => {
          const url = `${SUBMISSIONS_URL}/CIK${cik.cik}.json`;
          const response = await fetchLike(url, {
            headers: {
              'User-Agent': options.userAgent,
              Accept: 'application/json',
            },
            signal,
          });
          if (!response.ok) {
            return failure(
              emptyProfile(parsed.raw),
              retrievedAt,
              response.status === 403 ? 'AUTH_REQUIRED' : 'SOURCE_UNAVAILABLE',
              `SEC submissions HTTP ${response.status}`,
            );
          }
          const data = (await response.json()) as SecSubmissionsProfile;
          const issuerName = stringValue(data.name) ?? cik.name;
          const sicDescription = stringValue(data.sicDescription);
          const sic = stringValue(data.sic);
          const entityType = stringValue(data.entityType);
          const industry = sicDescription ?? (sic ? `SIC ${sic}` : undefined);
          const description = issuerName && (industry || entityType)
            ? `${issuerName} is an SEC registrant${entityType ? ` (${entityType})` : ''}${industry ? ` classified as ${industry}` : ''}.`
            : undefined;
          const profile: CompanyProfile = {
            instrument: instrument(parsed.raw, parsed.symbol),
            ...(description ? { description } : {}),
            ...(industry ? { industry } : {}),
          };
          const warnings: ResearchWarning[] = description
            ? []
            : [{
                code: 'PARTIAL_DATA',
                message: `SEC submissions has no SIC classification for ${parsed.symbol}.`,
                provider: PROVIDER,
                sourceType: 'FILING',
              }];
          return {
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            data: profile,
            citations: [{
              title: `SEC EDGAR issuer profile: ${issuerName ?? parsed.symbol}`,
              url,
              sourceType: 'FILING',
              provider: PROVIDER,
              retrievedAt,
              qualityTier: 'A',
            }],
            freshness: [{
              provider: PROVIDER,
              asOf: retrievedAt,
              retrievedAt,
              stale: false,
            }],
            warnings,
          };
        });
      } catch (error) {
        return failure(
          emptyProfile(parsed.raw),
          retrievedAt,
          'SOURCE_UNAVAILABLE',
          `SEC profile fetch failed: ${messageOf(error)}`,
        );
      }
    },
  };
}

function instrument(instrumentId: string, symbol: string): InstrumentRef {
  return { instrumentId, market: 'US', symbol, currency: 'USD' };
}

function emptyProfile(instrumentId: string): CompanyProfile {
  const symbol = instrumentId.split(':').at(-1) ?? instrumentId;
  return { instrument: instrument(instrumentId, symbol) };
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
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
