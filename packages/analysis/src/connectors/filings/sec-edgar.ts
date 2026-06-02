import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import type {
  FilingDocument,
  FilingGetInput,
  FilingPort,
  FilingSearchInput,
  FilingSummary,
} from '../../ports/filings';
import { parseInstrumentId } from '../../util/instrument-id';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';
import { createInMemoryCikLookup, type CikLookup } from './cik-lookup';

const PROVIDER = 'sec-edgar';
const SUBMISSIONS_URL = 'https://data.sec.gov/submissions';
const ARCHIVE_BASE = 'https://www.sec.gov/Archives/edgar/data';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_LIMIT = 20;

interface SecSubmissionsResponse {
  cik?: string;
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      form?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
    };
  };
}

export interface SecEdgarOptions {
  /**
   * SEC mandates a contact User-Agent for all requests; non-compliant
   * traffic is rejected with 403. Format: `App Name contact@example.com`.
   */
  userAgent: string;
  /** Override for tests; defaults to in-memory CIK lookup with same UA. */
  cikLookup?: CikLookup;
  /** Default fetchLike for both CIK lookup and filings calls. */
  fetchLike?: FetchLike;
  timeoutMs?: number;
}

export function createSecEdgarFilingsConnector(options: SecEdgarOptions): FilingPort {
  if (!options.userAgent?.trim()) {
    throw new Error('SecEdgar connector requires a non-empty userAgent (SEC compliance).');
  }
  const cikLookup =
    options.cikLookup ??
    createInMemoryCikLookup({
      userAgent: options.userAgent,
      ...(options.fetchLike ? { fetchLike: options.fetchLike } : {}),
    });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async searchFilings(input: FilingSearchInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<FilingSummary[]>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Invalid instrumentId: ${input.instrumentId}`);
      }
      if (parsed.market !== 'US') {
        return failure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `SEC EDGAR only handles US issuers; got ${parsed.market}`,
        );
      }

      const fetchLike = resolveFetch(ctx, options);

      let cik: { cik: string; name: string } | null;
      try {
        cik = await cikLookup.resolve(parsed.symbol, ctx);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `CIK lookup failed: ${message}`, message);
      }
      if (!cik) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Unknown SEC ticker: ${parsed.symbol}`);
      }
      const resolvedCik = cik;

      try {
        return await withTimeout(ctx, timeoutMs, async (signal) => {
        const url = `${SUBMISSIONS_URL}/CIK${resolvedCik.cik}.json`;
        const res = await fetchLike(url, {
          headers: { 'User-Agent': options.userAgent, Accept: 'application/json' },
          signal,
        });
        if (!res.ok) {
          return failure(
            retrievedAt,
            res.status === 403 ? 'AUTH_REQUIRED' : 'SOURCE_UNAVAILABLE',
            `SEC submissions HTTP ${res.status}`,
            `HTTP ${res.status}`,
          );
        }

        const data = (await res.json()) as SecSubmissionsResponse;
        const recent = data.filings?.recent;
        if (!recent || !recent.accessionNumber || !recent.form) {
          return failure(retrievedAt, 'PARTIAL_DATA', `SEC submissions empty for CIK ${resolvedCik.cik}`);
        }

        const wantedForms = input.forms?.map((f) => f.toUpperCase());
        const limit = clampLimit(input.limit);
        const fromDate = input.from ? new Date(input.from) : null;
        const toDate = input.to ? new Date(input.to) : null;

        const filings: FilingSummary[] = [];
        for (let i = 0; i < recent.accessionNumber.length; i += 1) {
          const form = recent.form[i] ?? '';
          if (wantedForms && !wantedForms.includes(form.toUpperCase())) continue;
          const filingDate = recent.filingDate?.[i] ?? '';
          if (fromDate && filingDate && new Date(filingDate) < fromDate) continue;
          if (toDate && filingDate && new Date(filingDate) > toDate) continue;
          const accession = recent.accessionNumber[i];
          const primary = recent.primaryDocument?.[i] ?? '';
          filings.push({
            id: accession,
            instrumentId: parsed.raw,
            formType: form,
            filingDate,
            filingUrl: buildFilingUrl(resolvedCik.cik, accession, primary),
            title: recent.primaryDocDescription?.[i] || `${form} ${filingDate}`,
            provider: PROVIDER,
          });
          if (filings.length >= limit) break;
        }

        const citations: ResearchCitation[] = filings.map((f) => ({
          title: f.title ?? f.filingUrl,
          url: f.filingUrl,
          sourceType: 'FILING',
          provider: PROVIDER,
          publishedAt: f.filingDate,
          retrievedAt,
          qualityTier: 'A', // PRD §8.4 — regulator originals
        }));

        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: filings,
          citations,
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
        });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', `SEC EDGAR error: ${message}`, message);
      }
    },

    async getFiling(_input: FilingGetInput): Promise<ResearchResult<FilingDocument>> {
      const retrievedAt = new Date().toISOString();
      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: { id: '', instrumentId: '', formType: '', filingDate: '', filingUrl: '', provider: PROVIDER },
        citations: [],
        freshness: [
          { provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: 'getFiling not implemented' },
        ],
        warnings: [
          {
            code: 'PARTIAL_DATA',
            message: 'SEC EDGAR full-text fetch not implemented in phase 2; only filings list available.',
            provider: PROVIDER,
          },
        ],
      };
    },
  };
}

/**
 * SEC archives URL pattern:
 *   https://www.sec.gov/Archives/edgar/data/{cik-no-pad}/{accession-no-dashes}/{primary-doc}
 */
function buildFilingUrl(paddedCik: string, accession: string, primaryDoc: string): string {
  const cikNoPad = String(Number(paddedCik));
  const dirAccession = accession.replace(/-/g, '');
  return `${ARCHIVE_BASE}/${cikNoPad}/${dirAccession}/${primaryDoc}`;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, 100);
}

function failure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
  cause?: string,
): ResearchResult<FilingSummary[]> {
  return httpFailure<FilingSummary[]>(PROVIDER, [], {
    retrievedAt,
    code,
    message,
    ...(cause ? { cause } : {}),
  });
}
