/**
 * Phase 3.C18b — CN A-share filings connector, ported from agent's
 * `filingSearchCN`. Cninfo (巨潮) primary, eastmoney fallback.
 * Lives in research-core to complete the A3 reverse migration.
 */
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchCitation } from '../../contracts/research-citation';
import type { ResearchWarning } from '../../contracts/warning';
import { computeContentHash } from '../../util/content-hash';
import { parseInstrumentId } from '../../util/instrument-id';
import type { ConnectorRunContext, FetchLike } from '../types';
import { failure as httpFailure, resolveFetch, withTimeout } from '../http';
import { CN_BROWSER_HEADERS, type Exchange, inferExchange } from '../cn-common';
import type {
  FilingDocument,
  FilingGetInput,
  FilingPort,
  FilingSearchInput,
  FilingSummary,
} from '../../ports/filings';

const PROVIDER = 'cn-filings';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LIMIT = 10;
const HARD_LIMIT = 30;

export type CnFilingType =
  | 'annual'
  | 'quarterly'
  | 'semiannual'
  | 'preview'
  | 'preliminary'
  | 'extraordinary'
  | 'other';

interface ParsedFiling {
  title: string;
  url: string;
  publishedAt: string;
  type: CnFilingType;
}

export interface CnFilingsOptions {
  fetchLike?: FetchLike;
  sources?: ReadonlyArray<'cninfo' | 'eastmoney'>;
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
        const result = await fetchFromSource(source, parsed.symbol, exchange, limit, fetchLike, ctx, retrievedAt);
        if (result.ok) {
          const filings: FilingSummary[] = result.filings
            .filter((f) => !wantedForms?.length || wantedForms.includes(f.type))
            .map((f) => ({
              id: computeContentHash({ canonicalUrl: f.url }),
              instrumentId: parsed.raw,
              formType: f.type,
              filingDate: f.publishedAt,
              filingUrl: f.url,
              title: f.title,
              provider: source,
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
            message: 'CN getFiling (full text/PDF parse) not implemented; only listings available.',
            provider: PROVIDER,
          },
        ],
      };
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
  fetchLike: FetchLike,
  ctx: ConnectorRunContext,
  retrievedAt: string,
): Promise<FetchOk | FetchErr> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await withTimeout(ctx, timeoutMs, (signal) => {
      if (source === 'cninfo') return fetchCninfo(symbol, exchange, limit, fetchLike, signal);
      return fetchEastmoney(symbol, limit, fetchLike, signal);
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
  fetchLike: FetchLike,
  signal: AbortSignal,
): Promise<FetchOk | FetchErr> {
  const plate = exchange === 'SS' ? 'sh' : exchange === 'SZ' ? 'sz' : 'bj';
  const column = exchange === 'SS' ? 'sse' : exchange === 'SZ' ? 'szse' : 'bj';
  const url = 'http://www.cninfo.com.cn/new/hisAnnouncement/query';

  const form = new URLSearchParams({
    pageNum: '1',
    pageSize: String(Math.min(limit, HARD_LIMIT)),
    column,
    tabName: 'fulltext',
    plate,
    stock: symbol,
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
    .slice(0, limit)
    .map((item) => parseCninfoItem(item))
    .filter((x): x is ParsedFiling => x !== null);
  if (!filings.length) return { ok: false, code: 'PARTIAL_DATA', message: 'cninfo: no parseable filings' };
  return { ok: true, filings };
}

function parseCninfoItem(raw: unknown): ParsedFiling | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.announcementTitle === 'string' ? o.announcementTitle : null;
  const adjunct = typeof o.adjunctUrl === 'string' ? o.adjunctUrl : null;
  const tsRaw = o.announcementTime;
  if (!title || !adjunct) return null;
  const ms = typeof tsRaw === 'number' ? tsRaw : Number(tsRaw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const url = `http://static.cninfo.com.cn/${adjunct}`;
  return {
    title,
    url,
    publishedAt: new Date(ms).toISOString(),
    type: classifyFilingTitle(title),
  };
}

async function fetchEastmoney(
  symbol: string,
  limit: number,
  fetchLike: FetchLike,
  signal: AbortSignal,
): Promise<FetchOk | FetchErr> {
  const url =
    `https://np-anotice-stock.eastmoney.com/api/security/ann` +
    `?cb=&sr=-1&page_size=${Math.min(limit, HARD_LIMIT)}&page_index=1` +
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
    .slice(0, limit)
    .map((item) => parseEastmoneyItem(item))
    .filter((x): x is ParsedFiling => x !== null);
  if (!filings.length) return { ok: false, code: 'PARTIAL_DATA', message: 'eastmoney: no parseable filings' };
  return { ok: true, filings };
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
    title,
    url: `https://pdf.dfcfw.com/pdf/H2_${artCode}_1.pdf`,
    publishedAt: new Date(t).toISOString(),
    type: classifyFilingTitle(title),
  };
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
