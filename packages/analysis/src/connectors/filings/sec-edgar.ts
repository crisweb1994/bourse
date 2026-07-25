import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import { load } from 'cheerio';
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
import { computeBinaryContentHash } from '../../util/content-hash';
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
      reportDate?: string[];
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
          const periodEndOn = recent.reportDate?.[i] || undefined;
          if (fromDate && filingDate && new Date(filingDate) < fromDate) continue;
          if (toDate && filingDate && new Date(filingDate) > toDate) continue;
          const accession = recent.accessionNumber[i];
          const primary = recent.primaryDocument?.[i] ?? '';
          filings.push({
            id: accession,
            sourceDocumentId: accession,
            sourceGroupId: accession,
            instrumentId: parsed.raw,
            formType: form,
            filingDate,
            ...(periodEndOn ? { periodEndOn } : {}),
            filingUrl: buildFilingUrl(resolvedCik.cik, accession, primary),
            title: recent.primaryDocDescription?.[i] || `${form} ${filingDate}`,
            provider: PROVIDER,
            documentKind: 'PRIMARY',
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

    async getFiling(input: FilingGetInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<FilingDocument>> {
      const retrievedAt = new Date().toISOString();
      if (!input.filingUrl || !isTrustedSecUrl(input.filingUrl)) {
        return documentFailure(input, retrievedAt, 'INVALID_INSTRUMENT', 'SEC filingUrl is required and must point to sec.gov Archives');
      }
      const fetchLike = resolveFetch(ctx, options);
      const base = filingDirectory(input.filingUrl);
      let documentUrl = input.filingUrl;
      let documentKind: FilingDocument['documentKind'] = 'PRIMARY';

      try {
        if ((input.formType ?? '').toUpperCase() === '8-K') {
          const indexUrl = `${base}/${input.id}-index.html`;
          const indexResponse = await withTimeout(ctx, timeoutMs, (signal) =>
            fetchLike(indexUrl, {
              headers: { 'User-Agent': options.userAgent, Accept: 'text/html' },
              signal,
            }),
          );
          if (indexResponse.ok && indexResponse.text) {
            const exhibit = selectEarningsExhibit(await indexResponse.text(), base);
            if (exhibit) {
              documentUrl = exhibit;
              documentKind = 'EARNINGS_RELEASE';
            }
          }
        }

        const response = await withTimeout(ctx, timeoutMs, (signal) =>
          fetchLike(documentUrl, {
            headers: { 'User-Agent': options.userAgent, Accept: 'text/html, text/plain' },
            signal,
          }),
        );
        if (!response.ok || !response.text) {
          return documentFailure(
            input,
            retrievedAt,
            response.status === 403 ? 'AUTH_REQUIRED' : 'SOURCE_UNAVAILABLE',
            `SEC filing document HTTP ${response.status}`,
          );
        }
        const raw = await response.text();
        const text = htmlToFilingText(raw);
        if (!text) {
          return documentFailure(input, retrievedAt, 'PARTIAL_DATA', 'SEC filing contained no readable text');
        }
        if (documentKind === 'EARNINGS_RELEASE' && !isEarningsReleaseText(text)) {
          documentKind = 'OTHER';
        }
        const filename = new URL(documentUrl).pathname.split('/').pop() ?? input.id;
        const sourceDocumentId = `${input.sourceGroupId ?? input.id}:${filename}`;
        const rawContent = new TextEncoder().encode(raw);
        const contentHash = computeBinaryContentHash(rawContent);
        const document: FilingDocument = {
          id: input.id,
          sourceDocumentId,
          sourceGroupId: input.sourceGroupId ?? input.id,
          instrumentId: input.instrumentId ?? '',
          formType: input.formType ?? '',
          filingDate: input.filingDate ?? '',
          periodEndOn: input.periodEndOn,
          filingUrl: documentUrl,
          title: input.title,
          provider: PROVIDER,
          documentKind,
          mimeType: 'text/html',
          rawContent,
          text,
          contentHash,
          retrievedAt,
        };
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: document,
          citations: [{
            title: input.title ?? `${input.formType ?? 'SEC filing'} ${input.id}`,
            url: documentUrl,
            sourceType: 'FILING',
            provider: PROVIDER,
            publishedAt: undefined,
            retrievedAt,
            qualityTier: 'A',
          }],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: documentKind !== 'EARNINGS_RELEASE' && (input.formType ?? '').toUpperCase() === '8-K'
            ? [{ code: 'PARTIAL_DATA', message: 'No earnings-qualified EX-99.1 exhibit found', provider: PROVIDER }]
            : [],
        };
      } catch (err) {
        return documentFailure(
          input,
          retrievedAt,
          'SOURCE_UNAVAILABLE',
          `SEC filing fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

function isTrustedSecUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.sec.gov' && url.pathname.startsWith('/Archives/');
  } catch {
    return false;
  }
}

function filingDirectory(filingUrl: string): string {
  return filingUrl.slice(0, filingUrl.lastIndexOf('/'));
}

export function selectEarningsExhibit(indexHtml: string, baseUrl: string): string | null {
  const $ = load(indexHtml);
  const candidates: Array<{ url: string; description: string; type: string }> = [];
  $('table.tableFile tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;
    const description = $(cells[1]).text().trim();
    const href = $(cells[2]).find('a').attr('href');
    const type = $(cells[3]).text().trim().toUpperCase();
    if (!href || !/^EX-99(?:\.1)?$/.test(type)) return;
    candidates.push({
      url: new URL(href, `${baseUrl}/`).toString(),
      description: description.toLowerCase(),
      type,
    });
  });
  candidates.sort((a, b) => {
    const score = (value: typeof a) =>
      (/earnings|results|release/.test(value.description) ? 2 : 0) + (value.type === 'EX-99.1' ? 1 : 0);
    return score(b) - score(a);
  });
  return candidates[0]?.url ?? null;
}

export function htmlToFilingText(html: string): string {
  const $ = load(html);
  $('script, style, noscript, template').remove();
  $('br').replaceWith('\n');
  $('p, div, section, article, tr, h1, h2, h3, h4, li').each((_, element) => {
    $(element).prepend('\n').append('\n');
  });
  return ($('body').text() || $.root().text())
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isEarningsReleaseText(text: string): boolean {
  const head = text.slice(0, 12_000);
  const hasResultsContext = /(?:financial\s+results|quarter(?:ly)?\s+results|earnings\s+(?:release|results)|results\s+for\s+(?:the\s+)?(?:first|second|third|fourth|fiscal)|reports?\s+(?:first|second|third|fourth|fiscal)\s+quarter)/i.test(head);
  const metricFamilies = [
    /\b(?:revenue|net\s+sales)\b/i,
    /\b(?:net\s+income|net\s+earnings|profit)\b/i,
    /\b(?:diluted|basic)\s+(?:earnings\s+per\s+share|eps)\b|\beps\b/i,
    /\b(?:operating\s+income|income\s+from\s+operations)\b/i,
    /\b(?:operating\s+cash\s+flow|cash\s+provided\s+by\s+operating)\b/i,
  ];
  return hasResultsContext && metricFamilies.filter((pattern) => pattern.test(head)).length >= 2;
}

function documentFailure(
  input: FilingGetInput,
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<FilingDocument> {
  return httpFailure<FilingDocument>(PROVIDER, {
    id: input.id,
    sourceDocumentId: input.sourceDocumentId ?? input.id,
    sourceGroupId: input.sourceGroupId ?? input.id,
    instrumentId: input.instrumentId ?? '',
    formType: input.formType ?? '',
    filingDate: input.filingDate ?? '',
    periodEndOn: input.periodEndOn,
    filingUrl: input.filingUrl ?? '',
    title: input.title,
    provider: PROVIDER,
  }, { retrievedAt, code, message });
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
