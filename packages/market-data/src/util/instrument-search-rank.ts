/**
 * 搜索结果的确定性排序（主上市代码优先）。
 *
 * 背景：腾讯/东财/Yahoo 对中文公司名会返回"港股主代码 + 美股 OTC ADR + 欧洲
 * 次级上市"等多个条目，且 OTC ADR 可能排在前面（如搜索"美团"腾讯先返回
 * us~mpngy.ps 再返回 hk~03690）。用户一旦点开 OTC ADR（MPNGY），美股财报
 * 通道没有 SEC 备案，功能不可用。
 *
 * 规则（分数从高到低，同分保持原顺序）：
 *   1. 查询与 symbol/yahooSymbol 精确一致 → +100（用户明确搜了 ADR 代码就尊重它）
 *   2. 主交易所（HKEX/HKG/NMS/NYQ/NASDAQ/SSE/…）→ +50
 *   3. OTC/粉单（PNK/OQB/OQX/OTC Markets）→ −30
 *   4. 次级外国交易所（FRA/STU/SES/…）→ −10
 */

export interface RankableInstrument {
  symbol: string;
  market: string;
  exchange: string;
  yahooSymbol?: string;
}

const PRIMARY_EXCHANGES = new Set([
  // US 主板
  'NMS', 'NYQ', 'NGM', 'NAS', 'PCX', 'BTS', 'NASDAQ', 'NYSE', 'AMEX',
  // HK
  'HKG', 'HKEX', 'HONG KONG',
  // CN
  'SSE', 'SZSE', 'BSE', 'SHH', 'SHZ',
  // JP / UK
  'TKS', 'TYO', 'JPX', 'LSE', 'LON',
]);

const OTC_EXCHANGE_PATTERN = /^(PNK|OQB|OQX|OTC|PINK)$/i;
const SECONDARY_EXCHANGE_PATTERN = /^(FRA|STU|MCE|MIL|PAR|GER|AMS|SES|LIS|BRU|DUS|HAM|MUN|SWX|TOR|MEX|FRANKFURT|SINGAPORE|STUTTGART|PARIS|MILAN|AMSTERDAM|LISBON|BRUSSELS|MUNICH|TORONTO|MEXICO)$/i;

export function rankInstrumentSearchResults<T extends RankableInstrument>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return items
    .map((item, index) => {
      let score = 0;
      const symbol = item.symbol.toLowerCase();
      const yahoo = (item.yahooSymbol ?? '').toLowerCase();
      if (symbol === q || yahoo === q) score += 100;
      if (PRIMARY_EXCHANGES.has(item.exchange)) score += 50;
      if (OTC_EXCHANGE_PATTERN.test(item.exchange)) score -= 30;
      if (SECONDARY_EXCHANGE_PATTERN.test(item.exchange)) score -= 10;
      return { item, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
