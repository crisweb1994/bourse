/**
 * Static peer table — sector → representative symbols for each market.
 *
 * Wave 0 seed list. Each entry is a small (5-10) curated set of
 * comparable names; the relative-compute helper looks the subject up by
 * sector and pulls its peers. This is intentionally hand-curated rather
 * than "top by market cap" so the peer set stays stable across rebal-
 * ancing and avoids the LLM picking idiosyncratic comparables.
 *
 * Sector taxonomy aligned with Yahoo Finance / Eastmoney BOARD_NAME
 * common labels. Keep keys lowercased and ASCII-normalized.
 */

export interface PeerEntry {
  symbol: string;
  name: string;
  market: 'US' | 'CN' | 'HK';
}

interface PeerGroupTable {
  US: Record<string, readonly PeerEntry[]>;
  CN: Record<string, readonly PeerEntry[]>;
  HK: Record<string, readonly PeerEntry[]>;
}

export const PEER_TABLE: PeerGroupTable = {
  US: {
    technology: [
      { symbol: 'AAPL', name: 'Apple', market: 'US' },
      { symbol: 'MSFT', name: 'Microsoft', market: 'US' },
      { symbol: 'GOOGL', name: 'Alphabet', market: 'US' },
      { symbol: 'META', name: 'Meta Platforms', market: 'US' },
      { symbol: 'NVDA', name: 'NVIDIA', market: 'US' },
      { symbol: 'ORCL', name: 'Oracle', market: 'US' },
    ],
    semiconductor: [
      { symbol: 'NVDA', name: 'NVIDIA', market: 'US' },
      { symbol: 'AMD', name: 'AMD', market: 'US' },
      { symbol: 'AVGO', name: 'Broadcom', market: 'US' },
      { symbol: 'INTC', name: 'Intel', market: 'US' },
      { symbol: 'TSM', name: 'TSMC ADR', market: 'US' },
      { symbol: 'QCOM', name: 'Qualcomm', market: 'US' },
    ],
    consumer_discretionary: [
      { symbol: 'AMZN', name: 'Amazon', market: 'US' },
      { symbol: 'TSLA', name: 'Tesla', market: 'US' },
      { symbol: 'HD', name: 'Home Depot', market: 'US' },
      { symbol: 'NKE', name: 'Nike', market: 'US' },
      { symbol: 'MCD', name: 'McDonald’s', market: 'US' },
    ],
    consumer_staples: [
      { symbol: 'PG', name: 'P&G', market: 'US' },
      { symbol: 'KO', name: 'Coca-Cola', market: 'US' },
      { symbol: 'PEP', name: 'PepsiCo', market: 'US' },
      { symbol: 'COST', name: 'Costco', market: 'US' },
      { symbol: 'WMT', name: 'Walmart', market: 'US' },
    ],
    healthcare: [
      { symbol: 'UNH', name: 'UnitedHealth', market: 'US' },
      { symbol: 'JNJ', name: 'Johnson & Johnson', market: 'US' },
      { symbol: 'LLY', name: 'Eli Lilly', market: 'US' },
      { symbol: 'PFE', name: 'Pfizer', market: 'US' },
      { symbol: 'ABBV', name: 'AbbVie', market: 'US' },
    ],
    financials: [
      { symbol: 'JPM', name: 'JPMorgan Chase', market: 'US' },
      { symbol: 'BAC', name: 'Bank of America', market: 'US' },
      { symbol: 'WFC', name: 'Wells Fargo', market: 'US' },
      { symbol: 'GS', name: 'Goldman Sachs', market: 'US' },
      { symbol: 'MS', name: 'Morgan Stanley', market: 'US' },
    ],
    energy: [
      { symbol: 'XOM', name: 'ExxonMobil', market: 'US' },
      { symbol: 'CVX', name: 'Chevron', market: 'US' },
      { symbol: 'COP', name: 'ConocoPhillips', market: 'US' },
      { symbol: 'EOG', name: 'EOG Resources', market: 'US' },
      { symbol: 'OXY', name: 'Occidental', market: 'US' },
    ],
    industrials: [
      { symbol: 'CAT', name: 'Caterpillar', market: 'US' },
      { symbol: 'GE', name: 'GE Aerospace', market: 'US' },
      { symbol: 'BA', name: 'Boeing', market: 'US' },
      { symbol: 'HON', name: 'Honeywell', market: 'US' },
      { symbol: 'UPS', name: 'UPS', market: 'US' },
    ],
  },
  CN: {
    baijiu: [
      { symbol: '600519', name: '贵州茅台', market: 'CN' },
      { symbol: '000858', name: '五粮液', market: 'CN' },
      { symbol: '000568', name: '泸州老窖', market: 'CN' },
      { symbol: '600809', name: '山西汾酒', market: 'CN' },
      { symbol: '000799', name: '酒鬼酒', market: 'CN' },
    ],
    new_energy_vehicle: [
      { symbol: '002594', name: '比亚迪', market: 'CN' },
      { symbol: '300750', name: '宁德时代', market: 'CN' },
      { symbol: '002460', name: '赣锋锂业', market: 'CN' },
      { symbol: '601127', name: '赛力斯', market: 'CN' },
    ],
    semiconductor: [
      { symbol: '688981', name: '中芯国际', market: 'CN' },
      { symbol: '603501', name: '韦尔股份', market: 'CN' },
      { symbol: '688012', name: '中微公司', market: 'CN' },
      { symbol: '002371', name: '北方华创', market: 'CN' },
    ],
    bank: [
      { symbol: '601398', name: '工商银行', market: 'CN' },
      { symbol: '601939', name: '建设银行', market: 'CN' },
      { symbol: '601288', name: '农业银行', market: 'CN' },
      { symbol: '601988', name: '中国银行', market: 'CN' },
      { symbol: '600036', name: '招商银行', market: 'CN' },
    ],
    medicine: [
      { symbol: '600276', name: '恒瑞医药', market: 'CN' },
      { symbol: '300760', name: '迈瑞医疗', market: 'CN' },
      { symbol: '603259', name: '药明康德', market: 'CN' },
      { symbol: '000538', name: '云南白药', market: 'CN' },
    ],
    insurance: [
      { symbol: '601318', name: '中国平安', market: 'CN' },
      { symbol: '601628', name: '中国人寿', market: 'CN' },
      { symbol: '601319', name: '中国人保', market: 'CN' },
    ],
    real_estate: [
      { symbol: '000002', name: '万科A', market: 'CN' },
      { symbol: '001979', name: '招商蛇口', market: 'CN' },
      { symbol: '600048', name: '保利发展', market: 'CN' },
    ],
  },
  HK: {
    internet: [
      { symbol: '0700', name: '腾讯控股', market: 'HK' },
      { symbol: '9988', name: '阿里巴巴-W', market: 'HK' },
      { symbol: '3690', name: '美团-W', market: 'HK' },
      { symbol: '1024', name: '快手-W', market: 'HK' },
      { symbol: '9618', name: '京东集团-SW', market: 'HK' },
    ],
    bank: [
      { symbol: '0005', name: '汇丰控股', market: 'HK' },
      { symbol: '0011', name: '恒生银行', market: 'HK' },
      { symbol: '2388', name: '中银香港', market: 'HK' },
    ],
    auto: [
      { symbol: '2015', name: '理想汽车', market: 'HK' },
      { symbol: '9866', name: '蔚来-SW', market: 'HK' },
      { symbol: '9868', name: '小鹏汽车-W', market: 'HK' },
    ],
    biotech: [
      { symbol: '1093', name: '石药集团', market: 'HK' },
      { symbol: '2269', name: '药明生物', market: 'HK' },
      { symbol: '1801', name: '信达生物', market: 'HK' },
    ],
  },
};

// ----------------------------------------------------------------------------
// Lookup helpers
// ----------------------------------------------------------------------------

/**
 * Find the peer group for a (market, sector) pair. Sector matching is
 * case-insensitive and tolerates spaces / hyphens / underscores.
 * Returns an empty array when no group matches.
 */
export function findPeerGroup(
  market: 'US' | 'CN' | 'HK',
  sector: string | null | undefined,
): readonly PeerEntry[] {
  if (!sector) return [];
  const key = normalizeSectorKey(sector);
  const group = PEER_TABLE[market];
  for (const [tableKey, entries] of Object.entries(group)) {
    if (tableKey === key) return entries;
  }
  return [];
}

/**
 * Reverse lookup: which sector key (if any) contains `symbol`?
 * Useful when a connector returned only the symbol without a sector tag.
 */
export function findSectorForSymbol(
  market: 'US' | 'CN' | 'HK',
  symbol: string,
): string | null {
  const group = PEER_TABLE[market];
  const target = symbol.toUpperCase();
  for (const [key, entries] of Object.entries(group)) {
    if (entries.some((e) => e.symbol.toUpperCase() === target)) return key;
  }
  return null;
}

function normalizeSectorKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}
