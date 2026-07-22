/**
 * Phase 3.C18b — CN A-share filings connector, ported from agent's
 * `filingSearchCN`. Cninfo (巨潮) primary, eastmoney fallback.
 * Lives in research-core to complete the A3 reverse migration.
 */
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import { computeBinaryContentHash, computeContentHash } from '../../util/content-hash';
import { parseInstrumentId } from '../../util/instrument-id';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';
import { CN_BROWSER_HEADERS, type Exchange, inferExchange } from '../cn-common';
import type {
  FilingDocument,
  FilingGetInput,
  FilingPage,
  FilingPort,
  FilingSearchInput,
  FilingSummary,
} from '../../ports/filings';

const PROVIDER = 'cn-filings';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LIMIT = 10;
const HARD_LIMIT = 30;
const FILTERED_SOURCE_WINDOW = 100;

export type CnFilingType =
  | 'annual'
  | 'quarterly'
  | 'semiannual'
  | 'preview'
  | 'preliminary'
  | 'extraordinary'
  | 'other';

interface ParsedFiling {
  sourceDocumentId: string;
  title: string;
  url: string;
  publishedAt: string;
  type: CnFilingType;
}

export interface CnFilingsOptions {
  fetchLike?: FetchLike;
  sources?: ReadonlyArray<'cninfo' | 'eastmoney'>;
  pdfParser?: (bytes: Uint8Array) => Promise<{ text: string; pages: FilingPage[] }>;
}

export function createCnFilingsConnector(options: CnFilingsOptions = {}): FilingPort {
  const sources = options.sources ?? (['cninfo', 'eastmoney'] as const);

  return {
    async searchFilings(input: FilingSearchInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<FilingSummary[]>> {
      const retrievedAt = new Date().toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Invalid instrumentId: ${input.instrumentId}`);
      }
      if (parsed.market !== 'CN') {
        return failure(
          retrievedAt,
          'UNSUPPORTED_MARKET',
          `cn-filings connector only handles CN; got ${parsed.market}`,
        );
      }
      const exchange = inferExchange(parsed.symbol);
      if (!exchange) {
        return failure(retrievedAt, 'INVALID_INSTRUMENT', `Cannot infer CN exchange for ${parsed.symbol}`);
      }

      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, HARD_LIMIT);
      const wantedForms = input.forms?.map((f) => f.toLowerCase());
      const fetchLike = resolveFetch(ctx, options);
      const warnings: ResearchWarning[] = [];

      for (const source of sources) {
        const result = await fetchFromSource(
          source,
          parsed.symbol,
          exchange,
          limit,
          wantedForms,
          fetchLike,
          ctx,
          retrievedAt,
        );
        if (result.ok) {
          const filings: FilingSummary[] = result.filings
            .map((f) => ({
              id: computeContentHash({ text: `${source}:${f.sourceDocumentId}` }),
              sourceDocumentId: f.sourceDocumentId,
              sourceGroupId: f.sourceDocumentId,
              instrumentId: parsed.raw,
              formType: f.type,
              filingDate: f.publishedAt,
              periodEndOn: inferCnPeriodEndOn(f.title, f.type),
              filingUrl: f.url,
              title: f.title,
              provider: source,
              documentKind: 'PDF',
            }));

          const citations: ResearchCitation[] = filings.slice(0, 5).map((f) => ({
            title: f.title ?? f.filingUrl,
            url: f.filingUrl,
            sourceType: 'FILING',
            provider: source,
            publishedAt: f.filingDate,
            retrievedAt,
            qualityTier: 'A', // PRD §8.4 — regulator originals
          }));

          return {
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            data: filings,
            citations,
            freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: false }],
            warnings,
          };
        }
        warnings.push({
          code: result.code,
          message: `${source}: ${result.message}`,
          provider: source,
          ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}),
        });
      }

      warnings.push({
        code: 'SOURCE_UNAVAILABLE',
        message: `cn filings exhausted sources: ${sources.join(',')}`,
        provider: PROVIDER,
      });
      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: [],
        citations: [],
        freshness: [{ provider: PROVIDER, asOf: retrievedAt, retrievedAt, stale: true, reason: 'all sources failed' }],
        warnings,
      };
    },

    async getFiling(input: FilingGetInput, ctx: ConnectorRunContext = {}): Promise<ResearchResult<FilingDocument>> {
      const retrievedAt = new Date().toISOString();
      if (!input.filingUrl || !isTrustedCnFilingUrl(input.filingUrl)) {
        return documentFailure(input, retrievedAt, 'INVALID_INSTRUMENT', 'CN filingUrl is required and must point to cninfo/eastmoney');
      }
      const fetchLike = resolveFetch(ctx, options);
      try {
        const response = await withTimeout(ctx, ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS * 3, (signal) =>
          fetchLike(input.filingUrl!, {
            headers: { ...CN_BROWSER_HEADERS, Accept: 'application/pdf' },
            signal,
          }),
        );
        if (!response.ok || !response.arrayBuffer) {
          return documentFailure(
            input,
            retrievedAt,
            response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE',
            `CN filing PDF HTTP ${response.status}`,
          );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        // pdfjs may transfer/detach the supplied ArrayBuffer. Preserve the wire
        // bytes and give the parser its own buffer so rawContent stays immutable.
        const parserBytes = bytes.slice();
        const contentHash = computeBinaryContentHash(bytes);
        const parsed = await (options.pdfParser ?? parsePdfText)(parserBytes);
        if (!parsed.text.trim()) {
          return documentFailure(input, retrievedAt, 'PARTIAL_DATA', 'CN filing PDF has no extractable text (possibly scanned)');
        }
        const provider = input.provider ?? PROVIDER;
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
          provider,
          documentKind: 'PDF',
          mimeType: 'application/pdf',
          rawContent: bytes,
          text: parsed.text,
          pages: parsed.pages,
          contentHash,
          retrievedAt,
        };
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: document,
          citations: [{
            title: input.title ?? 'A-share filing',
            url: input.filingUrl,
            sourceType: 'FILING',
            provider,
            retrievedAt,
            qualityTier: provider === 'cninfo' ? 'A' : 'B',
          }],
          freshness: [{ provider, asOf: retrievedAt, retrievedAt, stale: false }],
          warnings: [],
        };
      } catch (err) {
        return documentFailure(
          input,
          retrievedAt,
          'SOURCE_UNAVAILABLE',
          `CN filing PDF fetch/parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

// ─── Source fetchers ───────────────────────────────────────────────────────

interface FetchOk {
  ok: true;
  filings: ParsedFiling[];
}
interface FetchErr {
  ok: false;
  code: ResearchWarning['code'];
  message: string;
  retryAfterMs?: number;
}

async function fetchFromSource(
  source: 'cninfo' | 'eastmoney',
  symbol: string,
  exchange: Exchange,
  limit: number,
  wantedForms: string[] | undefined,
  fetchLike: FetchLike,
  ctx: ConnectorRunContext,
  retrievedAt: string,
): Promise<FetchOk | FetchErr> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await withTimeout(ctx, timeoutMs, (signal) => {
      if (source === 'cninfo') {
        return fetchCninfo(symbol, exchange, limit, wantedForms, fetchLike, signal);
      }
      return fetchEastmoney(symbol, limit, wantedForms, fetchLike, signal);
    });
  } catch (err) {
    void retrievedAt;
    const message = (err as Error)?.message ?? String(err);
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message };
  }
}

async function fetchCninfo(
  symbol: string,
  exchange: Exchange,
  limit: number,
  wantedForms: string[] | undefined,
  fetchLike: FetchLike,
  signal: AbortSignal,
): Promise<FetchOk | FetchErr> {
  const plate = exchange === 'SS' ? 'sh' : exchange === 'SZ' ? 'sz' : 'bj';
  const column = exchange === 'SS' ? 'sse' : exchange === 'SZ' ? 'szse' : 'bj';
  const url = 'http://www.cninfo.com.cn/new/hisAnnouncement/query';

  const orgId = await resolveCninfoOrgId(symbol, fetchLike, signal);
  const sourceWindow = wantedForms?.length ? FILTERED_SOURCE_WINDOW : limit;
  const form = new URLSearchParams({
    pageNum: '1',
    pageSize: String(sourceWindow),
    column,
    tabName: 'fulltext',
    plate,
    stock: orgId ? `${symbol},${orgId}` : symbol,
    searchkey: '',
    secid: '',
    category: '',
    trade: '',
    seDate: '',
    sortName: 'time',
    sortType: 'desc',
    isHLtitle: 'true',
  });

  const res = await fetchLike(url, {
    method: 'POST',
    headers: {
      ...CN_BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
    signal,
  });
  if (!res.ok) {
    if (res.status === 429) return { ok: false, code: 'RATE_LIMITED', message: 'HTTP 429', retryAfterMs: 30_000 };
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `HTTP ${res.status}` };
  }
  // cninfo returns JSON; use json() if available, else text+parse
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (!res.text) return { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'cninfo: json() and text() both unavailable' };
    const body = await res.text();
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'cninfo: JSON parse failed' };
    }
  }
  const raw = (parsed as { announcements?: unknown }).announcements;
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'PARTIAL_DATA', message: 'cninfo: missing announcements array' };
  }
  const filings = raw
    .map((item) => parseCninfoItem(item))
    .filter((x): x is ParsedFiling => x !== null)
    .filter((filing) => matchesWantedForm(filing, wantedForms))
    .slice(0, limit);
  if (!filings.length) {
    return {
      ok: false,
      code: 'PARTIAL_DATA',
      message: wantedForms?.length
        ? `cninfo: no matching filings in latest ${sourceWindow} announcements`
        : 'cninfo: no parseable filings',
    };
  }
  return { ok: true, filings };
}

async function resolveCninfoOrgId(
  symbol: string,
  fetchLike: FetchLike,
  signal: AbortSignal,
): Promise<string | null> {
  const url = 'http://www.cninfo.com.cn/new/information/topSearch/query';
  try {
    const res = await fetchLike(url, {
      method: 'POST',
      headers: {
        ...CN_BROWSER_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({ keyWord: symbol, maxSecNum: '10', maxListNum: '5' }).toString(),
      signal,
    });
    if (!res.ok) return null;
    const parsed = await res.json();
    if (!Array.isArray(parsed)) return null;
    const match = parsed.find((item) => {
      if (!item || typeof item !== 'object') return false;
      return (item as Record<string, unknown>).code === symbol;
    });
    if (!match || typeof match !== 'object') return null;
    const orgId = (match as Record<string, unknown>).orgId;
    return typeof orgId === 'string' && orgId.trim() ? orgId : null;
  } catch {
    // The primary query can still succeed on deployments where a bare symbol is accepted.
    return null;
  }
}

function parseCninfoItem(raw: unknown): ParsedFiling | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.announcementTitle === 'string' ? o.announcementTitle : null;
  const adjunct = typeof o.adjunctUrl === 'string' ? o.adjunctUrl : null;
  const announcementId =
    typeof o.announcementId === 'string' || typeof o.announcementId === 'number'
      ? String(o.announcementId)
      : null;
  const tsRaw = o.announcementTime;
  if (!title || !adjunct) return null;
  const ms = typeof tsRaw === 'number' ? tsRaw : Number(tsRaw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const url = `http://static.cninfo.com.cn/${adjunct}`;
  return {
    sourceDocumentId: announcementId ?? adjunct,
    title,
    url,
    publishedAt: new Date(ms).toISOString(),
    type: classifyFilingTitle(title),
  };
}

async function fetchEastmoney(
  symbol: string,
  limit: number,
  wantedForms: string[] | undefined,
  fetchLike: FetchLike,
  signal: AbortSignal,
): Promise<FetchOk | FetchErr> {
  const sourceWindow = wantedForms?.length ? FILTERED_SOURCE_WINDOW : limit;
  const url =
    `https://np-anotice-stock.eastmoney.com/api/security/ann` +
    `?cb=&sr=-1&page_size=${sourceWindow}&page_index=1` +
    `&ann_type=A&client_source=web&stock_list=${symbol}&f_node=0&s_node=0`;
  const res = await fetchLike(url, { headers: CN_BROWSER_HEADERS, signal });
  if (!res.ok) {
    if (res.status === 429) return { ok: false, code: 'RATE_LIMITED', message: 'HTTP 429', retryAfterMs: 30_000 };
    return { ok: false, code: 'SOURCE_UNAVAILABLE', message: `HTTP ${res.status}` };
  }
  const parsed = (await res.json()) as { data?: { list?: unknown } };
  const list = parsed?.data?.list;
  if (!Array.isArray(list)) {
    return { ok: false, code: 'PARTIAL_DATA', message: 'eastmoney: missing data.list array' };
  }
  const filings = list
    .map((item) => parseEastmoneyItem(item))
    .filter((x): x is ParsedFiling => x !== null)
    .filter((filing) => matchesWantedForm(filing, wantedForms))
    .slice(0, limit);
  if (!filings.length) {
    return {
      ok: false,
      code: 'PARTIAL_DATA',
      message: wantedForms?.length
        ? `eastmoney: no matching filings in latest ${sourceWindow} announcements`
        : 'eastmoney: no parseable filings',
    };
  }
  return { ok: true, filings };
}

function matchesWantedForm(filing: ParsedFiling, wantedForms: string[] | undefined): boolean {
  return !wantedForms?.length || wantedForms.includes(filing.type);
}

function parseEastmoneyItem(raw: unknown): ParsedFiling | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title : null;
  const artCode = typeof o.art_code === 'string' ? o.art_code : null;
  const dateStr =
    typeof o.notice_date === 'string' ? o.notice_date : typeof o.eiTime === 'string' ? o.eiTime : null;
  if (!title || !artCode || !dateStr) return null;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return null;
  return {
    sourceDocumentId: artCode,
    title,
    url: `https://pdf.dfcfw.com/pdf/H2_${artCode}_1.pdf`,
    publishedAt: new Date(t).toISOString(),
    type: classifyFilingTitle(title),
  };
}

function isTrustedCnFilingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      (url.hostname === 'static.cninfo.com.cn' || url.hostname === 'pdf.dfcfw.com')
    );
  } catch {
    return false;
  }
}

export async function parsePdfText(
  bytes: Uint8Array,
): Promise<{ text: string; pages: FilingPage[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  const pages: FilingPage[] = [];
  let fullText = '';
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (fullText && pageText) fullText += '\n\n';
      const adjustedStart = fullText.length;
      fullText += pageText;
      pages.push({
        page: pageNumber,
        text: pageText,
        startOffset: adjustedStart,
        endOffset: fullText.length,
      });
    }
  } finally {
    await loadingTask.destroy();
  }
  return { text: fullText, pages };
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
    sourceGroupId: input.sourceGroupId ?? input.sourceDocumentId ?? input.id,
    instrumentId: input.instrumentId ?? '',
    formType: input.formType ?? '',
    filingDate: input.filingDate ?? '',
    periodEndOn: input.periodEndOn,
    filingUrl: input.filingUrl ?? '',
    title: input.title,
    provider: input.provider ?? PROVIDER,
  }, { retrievedAt, code, message });
}

/**
 * Cheap regex-based classifier. Ported verbatim from agent — ordering
 * matters (semiannual before annual etc).
 */
export function classifyFilingTitle(title: string): CnFilingType {
  if (/中期报告|半年度报告|半年报/.test(title)) return 'semiannual';
  if (/第[一三]季度报告|一季报|三季报|季度报告/.test(title)) return 'quarterly';
  if (/业绩预告/.test(title)) return 'preview';
  if (/业绩快报/.test(title)) return 'preliminary';
  if (/年度报告/.test(title) && !/摘要/.test(title)) return 'annual';
  if (/(?:^|[^半季])\d{4}\s*年报/.test(title) || /^\d{4}年报$/.test(title)) return 'annual';
  if (/临时公告|重大事项|关于.*的公告|关联交易|股权激励|回购/.test(title)) return 'extraordinary';
  return 'other';
}

/** A-share fiscal periods follow the calendar year. Return nothing when the
 * announcement title does not identify one period unambiguously. */
export function inferCnPeriodEndOn(title: string, type: CnFilingType): string | undefined {
  const yearMatch = title.match(/(?:^|[^\d])(20\d{2})\s*年/);
  if (!yearMatch) return undefined;
  const year = yearMatch[1];
  if (type === 'quarterly') {
    if (/第一季度|一季报/.test(title)) return `${year}-03-31`;
    if (/第三季度|三季报/.test(title)) return `${year}-09-30`;
    return undefined;
  }
  if (type === 'semiannual' || /半年度|半年报|中期报告/.test(title)) return `${year}-06-30`;
  if (type === 'annual' || /年度|年报/.test(title)) return `${year}-12-31`;
  if (type === 'preview' || type === 'preliminary') {
    if (/第一季度|一季报/.test(title)) return `${year}-03-31`;
    if (/半年度|半年报/.test(title)) return `${year}-06-30`;
    if (/第三季度|三季报/.test(title)) return `${year}-09-30`;
    if (/年度|年报/.test(title)) return `${year}-12-31`;
  }
  return undefined;
}

// ─── helpers ───────────────────────────────────────────────────────────────

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
