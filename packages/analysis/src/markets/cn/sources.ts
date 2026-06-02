import type { DomainTier } from '../types';

/**
 * RFC-02 §7.2 — A-share source routing config.
 *
 * Single source of truth for:
 *   - Which domains are allowed in citations (and at what tier);
 *   - Which HTTP endpoints each source exposes;
 *   - Which sources to try (in order) for each EvidencePackV2 fact field.
 *
 * Tool adapters import directly from here; the CN MarketProfile also
 * embeds these objects via optional fields so callers that have only
 * the profile reference (e.g. dimension prompts) can reach them.
 */

// Code-side hard-coded domain tier. Keys are bare hostnames.
// CLAUDE.md §3.19 + RFC-02 §7.1 — LLM can downgrade but not upgrade.
export const CN_DOMAIN_TIERS: Record<string, DomainTier> = {
  // A: 监管 / 交易所 / 官方公告
  'cninfo.com.cn': 'A', // 巨潮资讯 (公告权威源)
  'sse.com.cn': 'A',    // 上交所
  'szse.cn': 'A',       // 深交所
  'csrc.gov.cn': 'A',   // 证监会
  'stats.gov.cn': 'A',  // 国家统计局
  'pbc.gov.cn': 'A',    // 央行
  // B: 一线财经 (含跨境)
  'eastmoney.com': 'B',     // 东方财富
  'dfcfw.com': 'B',         // 东方财富 CDN (PDF 等)
  'gtimg.cn': 'B',          // 腾讯财经 CDN (qt.gtimg.cn 行情)
  'cs.com.cn': 'B',         // 中国证券报
  'stcn.com': 'B',          // 证券时报
  'cailianpress.com': 'B',  // 财联社
  'reuters.com': 'B',
  'bloomberg.com': 'B',
  'ft.com': 'B',
  // C: 主流财经聚合
  'sina.com.cn': 'C',
  '163.com': 'C',           // 网易财经
  'jrj.com.cn': 'C',        // 金融界
  // D: 散户内容 (允许引用但不能独立支撑 HIGH 结论)
  '10jqka.com.cn': 'D',     // 同花顺散户内容
  'xueqiu.com': 'D',        // 雪球
  'gelonghui.com': 'D',     // 格隆汇
  // E: 不允许 (隐式 — 未列出即被 evidence gate 拒绝)
};

/**
 * HTTP endpoint base URLs per source.
 *
 * Tool adapters reference these by name, e.g.:
 *   const url = `${profile.endpoints.tencent.base}${profile.endpoints.tencent.quote}sh${code}`;
 *
 * URLs are intentionally specific (full path components, not just base
 * domains) so callers don't have to know the URL shape — they just pick
 * a source by name.
 */
export const CN_ENDPOINTS = {
  cninfo: {
    base: 'http://www.cninfo.com.cn',
    disclosure: '/new/hisAnnouncement/query',
    f10: '/data/f10',
  },
  eastmoney: {
    base: 'https://emweb.securities.eastmoney.com',
    reportapi: 'https://reportapi.eastmoney.com/report/list',
    news: 'https://np-anotice-stock.eastmoney.com/api/security/ann',
    fundamentals: 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index',
    lhb: 'https://data.eastmoney.com/api/data/v1/get',
    unlock: 'https://datacenter-web.eastmoney.com/api/data/get',
  },
  tencent: {
    base: 'https://qt.gtimg.cn',
    quote: '/q=', // append e.g. 'sh600519'
  },
  thsNorthbound: {
    base: 'http://data.10jqka.com.cn',
    flow: '/funds/hgt',
  },
  cailianpress: {
    base: 'https://www.cailianpress.com',
    flash: '/api/v1/global_telegraph/list',
  },
} as const satisfies Record<string, Record<string, string>>;

/**
 * Per-fact-field source priority list.
 *
 * Tools walk this list in order (when their fact field has multiple
 * sources). First source success → return. Source failure → try next.
 * All exhausted → tool throws, builder records dataAvailability.missing.
 *
 * Field names match EvidencePackV2 fact keys (EVIDENCE_PACK_V2_FACT_KEYS).
 */
export const CN_SOURCE_PRIORITIES: Record<string, string[]> = {
  quote: ['tencent', 'eastmoney'],
  marketCap: ['tencent', 'eastmoney'],
  pe: ['tencent', 'eastmoney'],
  latestFilingUrls: ['cninfo', 'eastmoney'],
  recentNews: ['eastmoney', 'cailianpress'],
  // financialStatement isn't a fact field on its own (it populates revenue/
  // netIncome/EPS into the broader fundamentals view) but tools key on it.
  financialStatement: ['eastmoney', 'cninfo'],
  consensusEps: ['eastmoney', 'thsNorthbound'],
  lhbAppearances: ['eastmoney'],
  // RFC-02 Phase 1: eastmoney has the working impl; thsNorthbound is kept as
  // fallback for the future RFC that adds the 10jqka adapter.
  northboundFlow: ['eastmoney', 'thsNorthbound'],
  unlockCalendar: ['eastmoney', 'cninfo'],
  shareholderConcentration: ['cninfo', 'eastmoney'],
  // peHistoricalPercentile is derived locally from quote + financialStatement.
  // Not a separately-fetched source.
};
