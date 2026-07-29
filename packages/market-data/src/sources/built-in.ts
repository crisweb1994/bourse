import type { MarketCode } from '../contracts/instrument';
import type { Capability, CapabilitySpec, SourceAuthority, RedistributionPolicy } from '../contracts/source';
import type { QualityTier } from '../contracts/research-citation';
import type { FinancePort, CompanyProfilePort } from '../ports/finance';
import type { FinancialsPort } from '../ports/financials';
import type { FilingPort } from '../ports/filings';
import type { MacroPort } from '../ports/macro';
import type { InstrumentSearchPort } from '../ports/instrument-search';
import type { SourceInstance } from './plugin';
import { createRuleBasedMarketCalendarPort } from './rule-calendar';

export interface BuiltInProviderPorts {
  twelveData?: FinancePort;
  alphaVantage?: FinancePort;
  eodhd?: FinancePort;
  yahoo: FinancePort;
  nasdaq: FinancePort;
  sinaUs: FinancePort;
  tencentHk: FinancePort;
  tencentCn?: FinancePort;
  cnFinance: FinancePort;
  secProfile: CompanyProfilePort;
  hkProfile?: CompanyProfilePort;
  usFinancials: FinancialsPort;
  cnFinancials: FinancialsPort;
  hkFinancials: FinancialsPort;
  usFilings: FilingPort;
  cnFilings: FilingPort;
  hkFilings: FilingPort;
  macro: MacroPort;
  instrumentSearch?: readonly InstrumentSearchPort[];
}

export function createBuiltInSources(providers: BuiltInProviderPorts): SourceInstance[] {
  const sources: SourceInstance[] = [
    financeSource('yahoo', 'Yahoo Finance', providers.yahoo, ['US', 'HK'], 'public-api', false, ['quote', 'history', 'profile']),
    financeSource('nasdaq', 'Nasdaq', providers.nasdaq, ['US'], 'public-api', false, ['quote', 'history']),
    financeSource('sina', 'Sina Finance', providers.sinaUs, ['US'], 'public-api', false, ['quote', 'history']),
    financeSource('tencent-hk', 'Tencent Finance', providers.tencentHk, ['HK'], 'public-api', false, ['quote', 'history']),
    financeSource('cn-finance', 'Eastmoney Finance', providers.cnFinance, ['CN'], 'aggregated', false, ['quote', 'history', 'profile']),
    profileSource('sec-edgar-profile', 'SEC EDGAR issuer profile', providers.secProfile, ['US'], 'regulator'),
    financialsSource('sec-edgar-xbrl', 'SEC EDGAR XBRL', providers.usFinancials, ['US'], 'regulator', 'A'),
    financialsSource('eastmoney-financials', 'Eastmoney Financials', providers.cnFinancials, ['CN'], 'aggregated', 'B'),
    financialsSource('eastmoney-hk-financials', 'Eastmoney HK Financials', providers.hkFinancials, ['HK'], 'aggregated', 'B'),
    filingsSource('sec-edgar', 'SEC EDGAR', providers.usFilings, ['US'], 'regulator', 'A'),
    filingsSource('cn-filings', 'CN regulatory filings', providers.cnFilings, ['CN'], 'exchange', 'A'),
    filingsSource('hkex', 'HKEX', providers.hkFilings, ['HK'], 'exchange', 'A'),
    macroSource(providers.macro),
    calendarSource(),
  ];
  if (providers.twelveData) sources.push(financeSource('twelve-data', 'Twelve Data', providers.twelveData, ['US', 'HK', 'CN'], 'licensed', true, ['quote', 'history', 'profile']));
  if (providers.alphaVantage) sources.push(financeSource('alpha-vantage', 'Alpha Vantage', providers.alphaVantage, ['US'], 'licensed', true, ['quote', 'history', 'profile']));
  if (providers.eodhd) sources.push(financeSource('eodhd', 'EODHD', providers.eodhd, ['US', 'HK', 'CN'], 'licensed', true, ['quote', 'history', 'profile']));
  if (providers.tencentCn) sources.push(financeSource('tencent-cn-history', 'Tencent Finance CN history', providers.tencentCn, ['CN'], 'public-api', false, ['history']));
  if (providers.hkProfile) sources.push(profileSource('eastmoney-hk-profile', 'Eastmoney HK profile', providers.hkProfile, ['HK'], 'aggregated'));
  for (const [index, port] of (providers.instrumentSearch ?? []).entries()) {
    const id = ['eastmoney-search', 'tencent-search', 'yahoo-search'][index] ?? `instrument-search-${index}`;
    sources.push(instrumentSearchSource(id, port));
  }
  return sources;
}

function financeSource(
  id: string,
  name: string,
  finance: FinancePort,
  markets: MarketCode[],
  authority: SourceAuthority,
  requiresAuth: boolean,
  capabilities: Array<'quote' | 'history' | 'profile'>,
): SourceInstance {
  return source(id, name, 'public-api', requiresAuth, capabilities.map((capability) => spec(capability, markets, authority, authority === 'licensed' ? 'B' : 'C', requiresAuth ? 'credential-cache-only' : 'public-cache-allowed')),
    { finance });
}

function profileSource(id: string, name: string, profile: CompanyProfilePort, markets: MarketCode[], authority: SourceAuthority): SourceInstance {
  return source(id, name, authority === 'regulator' ? 'official' : 'public-api', false, [spec('profile', markets, authority, authority === 'regulator' ? 'A' : 'B', 'public-cache-allowed')], { profile });
}

function financialsSource(id: string, name: string, financials: FinancialsPort, markets: MarketCode[], authority: SourceAuthority, qualityTier: QualityTier): SourceInstance {
  return source(id, name, authority === 'regulator' ? 'official' : 'public-api', false, [spec('financials', markets, authority, qualityTier, 'public-cache-allowed', 6 * 60 * 60 * 1_000)], { financials });
}

function filingsSource(id: string, name: string, filings: FilingPort, markets: MarketCode[], authority: SourceAuthority, qualityTier: QualityTier): SourceInstance {
  return source(id, name, authority === 'regulator' || authority === 'exchange' ? 'official' : 'public-api', false, [spec('filings', markets, authority, qualityTier, 'public-cache-allowed', 10 * 60 * 1_000)], { filings });
}

function macroSource(macro: MacroPort): SourceInstance {
  return source('official-macro', 'Official macro sources', 'official', false, [spec('macro', ['US', 'CN', 'HK'], 'regulator', 'A', 'public-cache-allowed', 60 * 60 * 1_000)], { macro });
}

function calendarSource(): SourceInstance {
  return source('market-calendar-rules', 'Market calendar rules', 'derived', false, [spec('market-calendar', ['US', 'CN', 'HK', 'JP', 'UK'], 'derived', 'C', 'public-cache-allowed', 60 * 60 * 1_000)], { marketCalendar: createRuleBasedMarketCalendarPort() });
}

function instrumentSearchSource(id: string, instrumentSearch: InstrumentSearchPort): SourceInstance {
  return source(id, id, 'public-api', false, [spec('instrument-search', ['US', 'CN', 'HK', 'JP', 'UK'], 'public-api', 'C', 'public-cache-allowed', 60 * 60 * 1_000)], { instrumentSearch });
}

function source(
  id: string,
  name: string,
  sourceType: SourceInstance['manifest']['sourceType'],
  requiresAuth: boolean,
  capabilities: CapabilitySpec[],
  ports: SourceInstance['ports'],
): SourceInstance {
  return {
    manifest: { id, name, sourceType, requiresAuth, allowRedistribution: capabilities.every((capability) => capability.redistribution === 'public-cache-allowed'), capabilities },
    enabled: true,
    credentialScope: requiresAuth ? `credential:${id}-system` : 'public',
    ports,
  };
}

function spec(
  capability: Capability,
  markets: MarketCode[],
  authority: SourceAuthority,
  qualityTier: QualityTier,
  redistribution: RedistributionPolicy,
  ttlMs = capability === 'quote' ? 15_000 : capability === 'history' ? 6 * 60 * 60 * 1_000 : 60 * 60 * 1_000,
): CapabilitySpec {
  return {
    capability,
    markets,
    authority,
    qualityTier,
    redistribution,
    ttlMs,
    ...(capability === 'quote' ? { delay: authority === 'licensed' ? 'delayed' as const : 'eod' as const } : {}),
    allowStaleIfError: capability === 'financials' || capability === 'filings',
    maxStaleMs: capability === 'financials' ? 24 * 60 * 60 * 1_000 : undefined,
  };
}
