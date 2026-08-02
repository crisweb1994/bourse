import { load } from 'cheerio';
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import { computeBinaryContentHash, computeContentHash } from '../../util/content-hash';
import { parseInstrumentId } from '../../util/instrument-id';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';
import type {
  FilingDocument,
  FilingGetInput,
  FilingPage,
  ProviderFilingPort as FilingPort,
  FilingSearchInput,
  FilingSummary,
} from '../../ports/filings';
import { parsePdfText } from './cn';

const PROVIDER = 'hkex';
const BASE_URL = 'https://www1.hkexnews.hk';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_LIMIT = 20;
const HARD_LIMIT = 40;
const DEFAULT_LOOKBACK_DAYS = 550;

interface HkexListItem {
  NEWS_ID?: string;
  TITLE?: string;
  LONG_TEXT?: string;
  DATE_TIME?: string;
  FILE_LINK?: string;
  FILE_TYPE?: string;
}

interface HkexSearchEnvelope {
  result?: string;
}

export interface HkexFilingsOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  pdfParser?: (bytes: Uint8Array) => Promise<{ text: string; pages: FilingPage[] }>;
}

export function createHkexFilingsConnector(options: HkexFilingsOptions = {}): FilingPort {
  return {
    async searchFilings(input, ctx = {}) {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed || parsed.market !== 'HK') {
        return failure(input, retrievedAt, 'UNSUPPORTED_MARKET', 'HKEX connector only handles HK instruments');
      }
      const symbol = ctx.resolvedInstrument?.instrumentId === parsed.raw
        ? ctx.resolvedInstrument.providerSymbol.replace(/\.HK$/i, '').replace(/^hk/i, '')
        : normalizeHkSymbol(parsed.symbol);
      if (!symbol) return failure(input, retrievedAt, 'INVALID_INSTRUMENT', `Invalid HK symbol: ${parsed.symbol}`);
      const fetchLike = resolveFetch(ctx, options);
      try {
        const stockId = await resolveHkexStockId(symbol, fetchLike, ctx, options);
        if (!stockId) return failure(input, retrievedAt, 'INVALID_INSTRUMENT', `HKEX issuer not found for ${symbol}`);
        const [english, chinese] = await Promise.all([
          searchLanguage('en', 'en-HK', stockId, symbol, input, fetchLike, ctx, options),
          searchLanguage('zh', 'zh-HK', stockId, symbol, input, fetchLike, ctx, options),
        ]);
        const wanted = new Set(input.forms?.map((form) => form.toLowerCase()) ?? []);
        const limit = Math.min(input.limit ?? DEFAULT_LIMIT, HARD_LIMIT);
        const filings = [...chinese, ...english]
          .filter((filing) => wanted.size === 0 || wanted.has(filing.formType.toLowerCase()))
          .sort((a, b) => b.filingDate.localeCompare(a.filingDate))
          .slice(0, limit);
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: filings,
          citations: filings.slice(0, 5).map(toCitation),
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
      } catch (error) {
        return failure(input, retrievedAt, 'SOURCE_UNAVAILABLE', error instanceof Error ? error.message : String(error));
      }
    },

    async getFiling(input, ctx = {}) {
      const retrievedAt = new Date().toISOString();
      if (!input.filingUrl || !isTrustedHkexUrl(input.filingUrl)) {
        return documentFailure(input, retrievedAt, 'INVALID_INSTRUMENT', 'HKEX filing URL is missing or untrusted');
      }
      const fetchLike = resolveFetch(ctx, options);
      try {
        const response = await withTimeout(ctx, options.timeoutMs ?? DEFAULT_TIMEOUT_MS * 2, (signal) =>
          fetchLike(input.filingUrl!, {
            headers: browserHeaders(input.filingUrl!),
            signal,
          }),
        );
        if (response.url && !isTrustedHkexUrl(response.url)) {
          return documentFailure(input, retrievedAt, 'SOURCE_UNAVAILABLE', 'HKEX filing redirected to an untrusted host');
        }
        if (!response.ok || !response.arrayBuffer) {
          return documentFailure(
            input,
            retrievedAt,
            response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE',
            `HKEX filing HTTP ${response.status}`,
          );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const finalUrl = response.url ?? input.filingUrl;
        const mimeType = finalUrl.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html';
        const parsed = mimeType === 'application/pdf'
          ? await (options.pdfParser ?? parsePdfText)(bytes.slice())
          : parseHtml(bytes);
        if (!parsed.text.trim()) {
          return documentFailure(input, retrievedAt, 'PARTIAL_DATA', 'HKEX document has no extractable text');
        }
        const document: FilingDocument = {
          id: input.id,
          sourceDocumentId: input.sourceDocumentId ?? input.id,
          sourceGroupId: input.sourceGroupId ?? input.sourceDocumentId ?? input.id,
          instrumentId: input.instrumentId ?? '',
          formType: input.formType ?? '',
          filingDate: input.filingDate ?? '',
          periodEndOn: input.periodEndOn,
          filingUrl: input.filingUrl,
          title: input.title,
          provider: PROVIDER,
          language: input.language ?? 'unknown',
          documentKind: mimeType === 'application/pdf' ? 'PDF' : 'PRIMARY',
          mimeType,
          text: parsed.text,
          pages: parsed.pages,
          contentHash: computeBinaryContentHash(bytes),
          retrievedAt,
        };
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: document,
          citations: [toCitation(document)],
          freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
      } catch (error) {
        return documentFailure(
          input,
          retrievedAt,
          'SOURCE_UNAVAILABLE',
          `HKEX filing fetch/parse failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

async function resolveHkexStockId(
  symbol: string,
  fetchLike: FetchLike,
  ctx: ConnectorRunContext,
  options: HkexFilingsOptions,
): Promise<string | null> {
  const url = `${BASE_URL}/search/prefix.do?callback=callback&lang=EN&type=A&name=${symbol}&market=SEHK`;
  const response = await withTimeout(ctx, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
    fetchLike(url, { headers: browserHeaders(url), signal }),
  );
  if (!response.ok || !response.text) throw new Error(`HKEX issuer lookup HTTP ${response.status}`);
  const body = await response.text();
  const match = body.trim().match(/callback\((.*)\);?\s*$/s);
  if (!match) throw new Error('HKEX issuer lookup returned invalid JSONP');
  const parsed = JSON.parse(match[1]) as { stockInfo?: Array<{ stockId?: number | string; code?: string }> };
  const stock = parsed.stockInfo?.find((candidate) => candidate.code === symbol);
  return stock?.stockId === undefined ? null : String(stock.stockId);
}

async function searchLanguage(
  lang: 'en' | 'zh',
  language: 'en-HK' | 'zh-HK',
  stockId: string,
  symbol: string,
  input: FilingSearchInput,
  fetchLike: FetchLike,
  ctx: ConnectorRunContext,
  options: HkexFilingsOptions,
): Promise<FilingSummary[]> {
  const now = options.now?.() ?? new Date();
  const from = input.from ? compactDate(new Date(input.from)) : compactDate(new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000));
  const to = input.to ? compactDate(new Date(input.to)) : compactDate(now);
  const titleQueries = input.forms?.length
    ? lang === 'zh' ? ['業績', '報告', '年報', '盈利', '盈警'] : ['results', 'report', 'profit warning']
    : [''];
  const queryResults = await Promise.all(titleQueries.map(async (title) => {
    const params = new URLSearchParams({
      lang,
      sortDir: '0',
      sortByOptions: 'DateTime',
      category: '0',
      market: 'SEHK',
      stockId,
      documentType: '-1',
      fromDate: from,
      toDate: to,
      title,
    });
    const url = `${BASE_URL}/search/titleSearchServlet.do?${params.toString()}`;
    const response = await withTimeout(ctx, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
      fetchLike(url, { headers: browserHeaders(url), signal }),
    );
    if (!response.ok) throw new Error(`HKEX title search HTTP ${response.status}`);
    const envelope = await response.json() as HkexSearchEnvelope;
    if (typeof envelope.result !== 'string') throw new Error('HKEX title search missing result');
    return JSON.parse(envelope.result) as HkexListItem[];
  }));
  const rows = queryResults.flat().filter((row, index, all) =>
    Boolean(row.NEWS_ID) && all.findIndex((candidate) => candidate.NEWS_ID === row.NEWS_ID) === index,
  );
  return rows.flatMap((row) => {
    const newsId = row.NEWS_ID?.trim();
    const fileLink = row.FILE_LINK?.trim();
    const dateTime = parseHkexDateTime(row.DATE_TIME);
    if (!newsId || !fileLink || !dateTime) return [];
    const title = decodeHtml(row.TITLE || row.LONG_TEXT || 'HKEX announcement');
    const formType = classifyHkexFiling(title);
    return [{
      id: computeContentHash({ text: `${PROVIDER}:${newsId}` }),
      sourceDocumentId: newsId,
      sourceGroupId: `${symbol}:${dateTime.toISOString().slice(0, 16)}:${formType}`,
      instrumentId: input.instrumentId,
      formType,
      filingDate: dateTime.toISOString(),
      periodEndOn: inferHkPeriodEndOn(title),
      filingUrl: new URL(fileLink, BASE_URL).toString(),
      title,
      provider: PROVIDER,
      language,
      documentKind: 'PDF' as const,
    }];
  });
}

export function classifyHkexFiling(title: string): string {
  const value = title.toLowerCase();
  if (/profit warning|profit alert|盈利警告|盈利預警|盈喜|盈警/.test(value)) return 'profit_warning';
  if (/quarterly results|季度業績|季度报告|季度報告/.test(value)) return 'quarterly';
  if (/interim report|中期報告/.test(value)) return 'interim';
  if (/annual report|年報|年度報告/.test(value)) return 'annual';
  if (/results announcement|annual results|final results|interim results|全年業績|年度業績|中期業績|業績公告/.test(value)) return 'preliminary';
  return 'other';
}

export function inferHkPeriodEndOn(title: string): string | undefined {
  const english = title.match(/(?:ended|as at)\s+(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})/i);
  if (english) {
    const month = MONTHS[english[2].toLowerCase()];
    return `${english[3]}-${month}-${english[1].padStart(2, '0')}`;
  }
  const numeric = title.match(/(?:截至|止於|ended)\s*(20\d{2})[年\-/](\d{1,2})[月\-/](\d{1,2})/i);
  return numeric ? `${numeric[1]}-${numeric[2].padStart(2, '0')}-${numeric[3].padStart(2, '0')}` : undefined;
}

function parseHkexDateTime(value: string | undefined): Date | null {
  const match = value?.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseHtml(bytes: Uint8Array): { text: string; pages: FilingPage[] } {
  const html = new TextDecoder().decode(bytes);
  const $ = load(html);
  $('script,style,noscript,nav').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return { text, pages: [{ page: 1, text, startOffset: 0, endOffset: text.length }] };
}

function decodeHtml(value: string): string {
  return load(`<span>${value.replace(/<br\s*\/?\s*>/gi, ' ')}</span>`)('span').text().replace(/\s+/g, ' ').trim();
}

function normalizeHkSymbol(value: string): string | null {
  const digits = value.replace(/\.HK$/i, '').replace(/^0+/, '');
  if (!/^\d{1,5}$/.test(digits)) return null;
  return digits.padStart(5, '0');
}

function compactDate(value: Date): string {
  return value.toISOString().slice(0, 10).replace(/-/g, '');
}

function isTrustedHkexUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'www1.hkexnews.hk' || url.hostname === 'www.hkexnews.hk');
  } catch {
    return false;
  }
}

function browserHeaders(referer: string): Record<string, string> {
  return {
    Accept: '*/*',
    'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8',
    Referer: referer.startsWith(BASE_URL) ? `${BASE_URL}/search/titlesearch.xhtml?lang=en` : BASE_URL,
    'User-Agent': 'Mozilla/5.0 (compatible; Bourse/1.0)',
  };
}

function toCitation(filing: FilingSummary): ResearchCitation {
  return {
    title: filing.title ?? filing.filingUrl,
    url: filing.filingUrl,
    sourceType: 'FILING',
    provider: PROVIDER,
    publishedAt: filing.filingDate,
    retrievedAt: new Date().toISOString(),
    qualityTier: 'A',
  };
}

function failure(input: FilingSearchInput, retrievedAt: string, code: 'UNSUPPORTED_MARKET' | 'INVALID_INSTRUMENT' | 'SOURCE_UNAVAILABLE', message: string): ResearchResult<FilingSummary[]> {
  void input;
  return httpFailure(PROVIDER, [], { retrievedAt, code, message });
}

function documentFailure(
  input: FilingGetInput,
  retrievedAt: string,
  code: 'INVALID_INSTRUMENT' | 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED' | 'PARTIAL_DATA',
  message: string,
): ResearchResult<FilingDocument> {
  return httpFailure(PROVIDER, {
    id: input.id,
    sourceDocumentId: input.sourceDocumentId ?? input.id,
    sourceGroupId: input.sourceGroupId ?? input.sourceDocumentId ?? input.id,
    instrumentId: input.instrumentId ?? '',
    formType: input.formType ?? '',
    filingDate: input.filingDate ?? '',
    periodEndOn: input.periodEndOn,
    filingUrl: input.filingUrl ?? '',
    title: input.title,
    provider: PROVIDER,
    language: input.language,
  }, { retrievedAt, code, message });
}

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};
