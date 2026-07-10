import type { EvidencePack } from '../contracts/evidence-pack';
import { enforceSymbol } from '../guardrails/symbol';
import type { AgentProvider } from './provider';

/**
 * Plan 3 §4.4.1 Stage A — assemble an immutable EvidencePack via a single
 * focused provider.stream call. The model is told to gather price, news,
 * financials, and risk facts; output is JSON that we parse, validate, and
 * freeze.
 *
 * Kept standalone so evidence recovery can run before any dimension report
 * exists and without requiring a comprehensive run to have completed.
 */
export interface BuildEvidencePackOptions {
  /** YYYY-MM-DD; defaults to today (UTC). */
  todayDate?: string;
  signal?: AbortSignal;
  /** Cap on web_search invocations during collection. Default 6. */
  maxToolUses?: number;
  /** Locale for the collected text. Default zh-CN. */
  locale?: string;
}

export interface EvidencePackInput {
  symbol: string;
  market: string;
  name?: string;
}

const COLLECTION_SYSTEM = `你是一名投资研究的事实包收集员。任务：用 web search 在一轮内收集目标股票的基础事实，输出严格 JSON。

【硬性要求】
- 只输出 JSON 对象本身，不要任何前后缀文字、不要 markdown 代码块标记、不要解释
- 必须以 { 开头、以 } 结尾
- 所有字符串使用双引号；数字字段无数据时用 null（不要 "N/A" 字符串）
- 所有 URL 字段必须是合法 http(s) URL

【输出 schema】
{
  "financialSnapshot": {
    "price": <当前价格 number 或 null>,
    "marketCap": <市值 number 或 null>,
    "pe": <PE 倍数 number 或 null>,
    "revenueGrowth": <近 12 个月收入增速 (0.15 表示 15%) number 或 null>,
    "netMargin": <近 12 个月净利率 number 或 null>,
    "fcfYield": <自由现金流收益率 number 或 null>
  },
  "news": [
    { "title": "...", "url": "...", "publishedAt": "ISO 8601 时间戳", "sentiment": "POSITIVE" | "NEGATIVE" | "NEUTRAL" }
    // 至少 3 条、至多 10 条；都要是近 30 天内
  ],
  "valuation": {
    "peerPE": [<同业 PE 数组，至少 2 个>] 或 [],
    "historicalPE": { "p25": number, "p50": number, "p75": number } 或 null
  },
  "riskFacts": [
    "<一句话描述的风险事实 1>",
    "<一句话描述的风险事实 2>",
    // 至少 3 条、至多 8 条
  ],
  "allUrls": [
    "<所有引用过的 URL 集合，去重>"
  ]
}

【风格】
- 不要给出投资建议、不要做估值判断、不要推荐买卖
- 只描述事实，禁止形容词"优秀 / 糟糕"等评价性表述
- 风险事实必须是**具体的事**，不要空洞表述如"宏观风险"`;

function buildUserPrompt(input: EvidencePackInput, todayDate: string): string {
  const name = input.name ?? input.symbol;
  return `请收集 ${name}（${input.symbol}，${input.market} 市场）的事实包。今日：${todayDate}。

重点搜索：
1. 实时股价 / 市值（最新交易日）
2. 最近 30 天的公司新闻 5-10 条
3. 同业 PE 中位数（至少找 2 家可比公司）
4. 公司当前财年的收入增速、净利率
5. 治理 / 监管 / 行业层面的具体风险事件

只输出 JSON，不要任何解释。`;
}

/**
 * Build a frozen EvidencePack. Throws on parse failure (caller decides
 * whether to retry with a different prompt or fall back).
 */
export async function buildEvidencePack(
  provider: AgentProvider,
  input: EvidencePackInput,
  options: BuildEvidencePackOptions = {},
): Promise<EvidencePack> {
  const guard = enforceSymbol(input.symbol, input.market);
  const symbol = guard.normalized;
  const market = guard.market.code;
  const todayDate = options.todayDate ?? new Date().toISOString().slice(0, 10);
  const capturedAt = new Date().toISOString();

  const userPrompt = buildUserPrompt(
    { symbol, market, name: input.name },
    todayDate,
  );

  const streamResult = await provider.stream(
    COLLECTION_SYSTEM,
    userPrompt,
    // No streaming UI for EvidencePack collection; workflows only need the
    // final structured result + citations.
    () => {},
    {
      signal: options.signal,
      maxToolUses: options.maxToolUses ?? 6,
    },
  );

  const parsed = parseJsonObject(streamResult.text);
  const allowedUrls = dedupeUrls([
    ...streamResult.citations.map((c) => c.url),
    ...(Array.isArray(parsed.allUrls) ? parsed.allUrls : []),
  ]);

  const pack: EvidencePack = {
    schemaVersion: 'evidence-pack-v1',
    symbol,
    market,
    capturedAt,
    financialSnapshot: pickFinancialSnapshot(parsed.financialSnapshot),
    news: pickNews(parsed.news, allowedUrls),
    valuation: pickValuation(parsed.valuation),
    riskFacts: pickRiskFacts(parsed.riskFacts),
    allowedUrls,
  };

  // Freeze the pack so workflow consumers cannot mutate shared facts.
  return Object.freeze({
    ...pack,
    financialSnapshot: Object.freeze(pack.financialSnapshot),
    valuation: Object.freeze(pack.valuation),
    news: Object.freeze(pack.news.map((n) => Object.freeze(n))) as EvidencePack['news'],
    riskFacts: Object.freeze([...pack.riskFacts]) as unknown as EvidencePack['riskFacts'],
    allowedUrls: Object.freeze([...pack.allowedUrls]) as unknown as EvidencePack['allowedUrls'],
  }) as EvidencePack;
}

// ===== Helpers =====

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('EvidencePack collection: no JSON object in response');
  }
  const slice = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `EvidencePack collection: JSON parse failed: ${(e as Error).message}`,
    );
  }
}

function dedupeUrls(urls: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (typeof u !== 'string') continue;
    if (!/^https?:\/\//.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function pickFinancialSnapshot(
  raw: unknown,
): EvidencePack['financialSnapshot'] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    price: num(r.price),
    marketCap: num(r.marketCap),
    pe: num(r.pe),
    revenueGrowth: num(r.revenueGrowth),
    netMargin: num(r.netMargin),
    fcfYield: num(r.fcfYield),
  };
}

function pickNews(
  raw: unknown,
  allowedUrls: string[],
): EvidencePack['news'] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(allowedUrls);
  const out: EvidencePack['news'] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.title !== 'string' || typeof o.url !== 'string') continue;
    if (!/^https?:\/\//.test(o.url)) continue;
    // News url must be in allowedUrls (which already includes the LLM-self-
    // reported allUrls + provider citations).
    if (!allowed.has(o.url)) continue;
    const publishedAt =
      typeof o.publishedAt === 'string' && !Number.isNaN(Date.parse(o.publishedAt))
        ? new Date(o.publishedAt).toISOString()
        : null;
    if (!publishedAt) continue;
    const sentiment =
      o.sentiment === 'POSITIVE' || o.sentiment === 'NEGATIVE' || o.sentiment === 'NEUTRAL'
        ? o.sentiment
        : undefined;
    out.push({
      title: o.title,
      url: o.url,
      publishedAt,
      ...(sentiment ? { sentiment } : {}),
    });
  }
  return out;
}

function pickValuation(raw: unknown): EvidencePack['valuation'] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const peerPE = Array.isArray(r.peerPE)
    ? (r.peerPE.filter((n): n is number => typeof n === 'number') as number[])
    : undefined;
  const h = (r.historicalPE ?? null) as Record<string, unknown> | null;
  const historicalPE =
    h &&
    typeof h.p25 === 'number' &&
    typeof h.p50 === 'number' &&
    typeof h.p75 === 'number'
      ? { p25: h.p25, p50: h.p50, p75: h.p75 }
      : undefined;
  return {
    ...(peerPE && peerPE.length > 0 ? { peerPE } : {}),
    ...(historicalPE ? { historicalPE } : {}),
  };
}

function pickRiskFacts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}
