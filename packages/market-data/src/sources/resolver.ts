import type { Capability, SecurityType } from '../contracts/source';
import type { MarketCode } from '../contracts/instrument';
import { parseInstrumentId } from '../util/instrument-id';

export interface ResolvedInstrument {
  instrumentId: string;
  market: MarketCode;
  symbol: string;
  providerSymbol: string;
  exchange?: string;
  currency?: string;
  timezone?: string;
  securityType: SecurityType;
}

export interface InstrumentResolver {
  resolve(input: { instrumentId: string; sourceId: string; capability: Capability }): ResolvedInstrument | null;
}

/** Provider mappings remain deterministic rules until a versioned master is justified. */
export class DefaultInstrumentResolver implements InstrumentResolver {
  resolve(input: { instrumentId: string; sourceId: string; capability: Capability }): ResolvedInstrument | null {
    const parsed = parseInstrumentId(input.instrumentId);
    if (!parsed) return null;
    const symbol = providerSymbol(parsed.market, parsed.symbol, input.sourceId);
    return {
      instrumentId: parsed.raw,
      market: parsed.market,
      symbol: parsed.symbol,
      providerSymbol: symbol,
      securityType: parsed.symbol.startsWith('^') ? 'index' : 'stock',
      ...marketMetadata(parsed.market),
    };
  }
}

function providerSymbol(market: MarketCode, symbol: string, sourceId: string): string {
  if (sourceId === 'eodhd') {
    if (market === 'US') return `${symbol.toUpperCase()}.US`;
    if (market === 'HK') return `${symbol.replace(/\.HK$/i, '').padStart(4, '0').slice(-4)}.HK`;
    if (market === 'CN') return `${symbol}.${/^(5|6|9)/.test(symbol) ? 'SHG' : 'SHE'}`;
  }
  if (sourceId === 'twelve-data') {
    if (market === 'US') return symbol.toUpperCase();
    if (market === 'HK') return `${symbol.replace(/\.HK$/i, '').padStart(4, '0').slice(-4)}:HKEX`;
    if (market === 'CN') return `${symbol}:${/^(5|6|9)/.test(symbol) ? 'SSE' : 'SZSE'}`;
  }
  if (market === 'HK') {
    const padded = symbol.padStart(5, '0');
    if (sourceId === 'tencent-hk') return `hk${padded}`;
    // Yahoo, EODHD and Twelve Data use the familiar four-digit HK ticker
    // form (`0700.HK`), while HKEX/Eastmoney consume five digits (`00700`).
    if (sourceId === 'yahoo') {
      const vendorCode = /^0\d{4}$/.test(padded) ? padded.slice(1) : padded;
      return `${vendorCode}.HK`;
    }
    if (sourceId === 'eastmoney-hk-profile' || sourceId === 'eastmoney-hk-financials') return `${padded}.HK`;
    return padded;
  }
  if (market === 'CN') {
    const exchange = /^(600|601|603|605|688|900)/.test(symbol) ? 'sh' : 'sz';
    if (sourceId === 'tencent-cn-history') return `${exchange}${symbol}`;
    if (sourceId === 'eastmoney' || sourceId === 'cn-finance') return `${exchange === 'sh' ? '1' : '0'}.${symbol}`;
  }
  return symbol;
}

function marketMetadata(market: MarketCode): Pick<ResolvedInstrument, 'currency' | 'timezone' | 'exchange'> {
  switch (market) {
    case 'US': return { currency: 'USD', timezone: 'America/New_York' };
    case 'CN': return { currency: 'CNY', timezone: 'Asia/Shanghai' };
    case 'HK': return { currency: 'HKD', timezone: 'Asia/Hong_Kong', exchange: 'HKEX' };
    case 'JP': return { currency: 'JPY', timezone: 'Asia/Tokyo' };
    case 'UK': return { currency: 'GBP', timezone: 'Europe/London' };
  }
}
