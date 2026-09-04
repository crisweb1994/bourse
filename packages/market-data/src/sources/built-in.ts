import type { MarketCode } from '../contracts/instrument';
import type { Capability, CapabilitySpec, SourceAuthority, RedistributionPolicy } from '../contracts/source';
import type { QualityTier } from '../contracts/research-citation';
import type { ProviderFinancePort, ProviderCompanyProfilePort } from '../ports/finance';
import type { ProviderFinancialsPort } from '../ports/financials';
import type { ProviderFilingPort } from '../ports/filings';
import type { ProviderMacroPort } from '../ports/macro';
import type { ProviderInstrumentSearchPort } from '../ports/instrument-search';
import type { ProviderOwnershipPort } from '../ports/ownership';
import type { ProviderMarketEventsPort } from '../ports/market-events';
import type { ProviderCorporateActionsPort } from '../ports/corporate-actions';
import type { EquityScreenerPort } from '../ports/equity-screener';
import type { SourceInstance, SourcePlugin } from './plugin';
import { createRuleBasedMarketCalendarPort } from './rule-calendar';
import {
  sourceFilingPort,
  sourceCorporateActionsPort,
  sourceFinancePort,
  sourceFinancialsPort,
  sourceInstrumentSearchPort,
  sourceMacroPort,
  sourceMarketEventsPort,
  sourceOwnershipPort,
  sourceProfilePort,
} from './provider-port';

interface BuiltInProviderPorts {
  twelveData?: ProviderFinancePort;
  alphaVantage?: ProviderFinancePort;
  eodhd?: ProviderFinancePort;
  yahoo?: ProviderFinancePort;
  nasdaq?: ProviderFinancePort;
  sinaUs?: ProviderFinancePort;
  tencentHk?: ProviderFinancePort;
  tencentCn?: ProviderFinancePort;
  cnFinance?: ProviderFinancePort;
  secProfile?: ProviderCompanyProfilePort;
  hkProfile?: ProviderCompanyProfilePort;
  usFinancials?: ProviderFinancialsPort;
  cnFinancials?: ProviderFinancialsPort;
  hkFinancials?: ProviderFinancialsPort;
  hkexFinancials?: ProviderFinancialsPort;
  usFilings?: ProviderFilingPort;
  cnFilings?: ProviderFilingPort;
  hkFilings?: ProviderFilingPort;
  macro?: ProviderMacroPort;
  instrumentSearch?: readonly ProviderInstrumentSearchPort[];
  cnOwnership?: ProviderOwnershipPort;
  cnEvents?: ProviderMarketEventsPort;
  hkCorporateActions?: ProviderCorporateActionsPort;
  hkEvents?: ProviderMarketEventsPort;
  hkOwnership?: ProviderOwnershipPort;
  cnEquityScreener?: EquityScreenerPort;
}


/** @internal Test/embedding/production helper: the built-in instances. */
export function createBuiltInSources(providers: BuiltInProviderPorts): SourceInstance[] {
  return builtInInstances(providers);
}

function builtInInstances(providers: BuiltInProviderPorts): SourceInstance[] {
  const sources: SourceInstance[] = [calendarSource()];
  if (providers.yahoo) sources.push(financeSource('yahoo', 'Yahoo Finance', providers.yahoo, ['US', 'HK'], 'public-api', false, ['quote', 'history', 'profile']));
  if (providers.nasdaq) sources.push(financeSource('nasdaq', 'Nasdaq', providers.nasdaq, ['US'], 'public-api', false, ['quote', 'history']));
  if (providers.sinaUs) sources.push(financeSource('sina', 'Sina Finance', providers.sinaUs, ['US'], 'public-api', false, ['quote', 'history']));
  if (providers.tencentHk) sources.push(financeSource('tencent-hk', 'Tencent Finance', providers.tencentHk, ['HK'], 'public-api', false, ['quote', 'history']));
  if (providers.cnFinance) sources.push(financeSource('cn-finance', 'Eastmoney Finance', providers.cnFinance, ['CN'], 'aggregated', false, ['quote', 'history', 'profile']));
  if (providers.secProfile) sources.push(profileSource('sec-edgar-profile', 'SEC EDGAR issuer profile', providers.secProfile, ['US'], 'regulator'));
  if (providers.usFinancials) sources.push(financialsSource('sec-edgar-xbrl', 'SEC EDGAR XBRL', providers.usFinancials, ['US'], 'regulator', 'A'));
  if (providers.cnFinancials) sources.push(financialsSource('eastmoney-financials', 'Eastmoney Financials', providers.cnFinancials, ['CN'], 'aggregated', 'B'));
  if (providers.hkFinancials) sources.push(financialsSource('eastmoney-hk-financials', 'Eastmoney HK Financials', providers.hkFinancials, ['HK'], 'aggregated', 'B'));
  if (providers.hkexFinancials) sources.push(financialsSource('hkex-derived-financials', 'HKEX derived financials', providers.hkexFinancials, ['HK'], 'official-derived', 'A'));
  if (providers.usFilings) sources.push(filingsSource('sec-edgar', 'SEC EDGAR', providers.usFilings, ['US'], 'regulator', 'A'));
  if (providers.cnFilings) sources.push(filingsSource('cn-filings', 'CN regulatory filings', providers.cnFilings, ['CN'], 'exchange', 'A'));
  if (providers.hkFilings) sources.push(filingsSource('hkex', 'HKEX', providers.hkFilings, ['HK'], 'exchange', 'A'));
  if (providers.macro) sources.push(macroSource(providers.macro));
  if (providers.cnOwnership) sources.push(cnOwnershipSource(providers.cnOwnership));
  if (providers.cnEvents) sources.push(cnEventsSource(providers.cnEvents));
  if (providers.hkCorporateActions || providers.hkEvents) sources.push(hkDerivedEventsSource(providers.hkCorporateActions, providers.hkEvents));
  if (providers.hkOwnership) sources.push(hkOwnershipSource(providers.hkOwnership));
  if (providers.cnEquityScreener) sources.push(cnEquityScreenerSource(providers.cnEquityScreener));
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

function cnEquityScreenerSource(equityScreener: EquityScreenerPort): SourceInstance {
  return source('eastmoney-cn-screener', 'Eastmoney CN equity screener', 'public-api', false, [{
    ...spec('equity-screener', ['CN'], 'aggregated', 'B', 'public-cache-allowed', 15_000),
    securityTypes: ['stock'],
    delay: 'delayed',
    transport: 'scrape',
    rateLimit: { concurrent: 1 },
  }], { equityScreener });
}

function hkDerivedEventsSource(
  corporateActions?: ProviderCorporateActionsPort,
  events?: ProviderMarketEventsPort,
): SourceInstance {
  const capabilities: CapabilitySpec[] = [];
  if (corporateActions) capabilities.push({
    ...spec('corporate-actions', ['HK'], 'official-derived', 'A', 'public-cache-allowed', 60 * 60 * 1_000),
    dataSets: ['dividend', 'split', 'rights-issue', 'placement', 'buyback'],
    securityTypes: ['stock'],
    transport: 'derived',
    rateLimit: { concurrent: 8 },
  });
  if (events) capabilities.push({
    ...spec('market-events', ['HK'], 'official-derived', 'A', 'public-cache-allowed', 30 * 60 * 1_000),
    dataSets: ['earnings-guidance', 'suspension', 'regulatory-event'],
    securityTypes: ['stock'],
    transport: 'derived',
    rateLimit: { concurrent: 8 },
  });
  return source('hkex-filings-derived-events', 'HKEX filings derived events', 'derived', false, capabilities, {
    ...(corporateActions ? { corporateActions: sourceCorporateActionsPort('hkex-filings-derived-events', corporateActions) } : {}),
    ...(events ? { marketEvents: sourceMarketEventsPort('hkex-filings-derived-events', events) } : {}),
  });
}

function hkOwnershipSource(ownership: ProviderOwnershipPort): SourceInstance {
  return source('sfc-short-position', 'SFC aggregated short positions', 'official', false, [{
    ...spec('ownership', ['HK'], 'regulator', 'A', 'public-cache-allowed', 6 * 60 * 60 * 1_000),
    dataSets: ['short-position'],
    securityTypes: ['stock'],
    transport: 'official-file',
  }], { ownership: sourceOwnershipPort('sfc-short-position', ownership) });
}

function cnOwnershipSource(ownership: ProviderOwnershipPort): SourceInstance {
  return source('cn-public-ownership', 'CN public ownership data', 'public-api', false, [{
    ...spec('ownership', ['CN'], 'aggregated', 'C', 'no-store', 60 * 60 * 1_000),
    dataSets: ['stock-connect', 'shareholder-count'],
    securityTypes: ['stock'],
    transport: 'scrape',
  }], { ownership: sourceOwnershipPort('cn-public-ownership', ownership) });
}

function cnEventsSource(events: ProviderMarketEventsPort): SourceInstance {
  return source('cn-public-events', 'CN public market events', 'public-api', false, [{
    ...spec('market-events', ['CN'], 'aggregated', 'C', 'no-store', 60 * 60 * 1_000),
    dataSets: ['lhb', 'unlock'],
    securityTypes: ['stock'],
    transport: 'scrape',
  }], { marketEvents: sourceMarketEventsPort('cn-public-events', events) });
}

function financeSource(
  id: string,
  name: string,
  finance: ProviderFinancePort,
  markets: MarketCode[],
  authority: SourceAuthority,
  requiresAuth: boolean,
  capabilities: Array<'quote' | 'history' | 'profile'>,
): SourceInstance {
  const declared: Capability[] = [
    ...capabilities,
    ...(finance.fetchEarningsConsensus ? ['earnings-consensus' as const] : []),
  ];
  return source(id, name, requiresAuth ? 'licensed-vendor' : 'public-api', requiresAuth, declared.map((capability) => ({
    ...spec(capability, markets, authority, authority === 'licensed' ? 'B' : 'C', requiresAuth ? 'credential-cache-only' : 'public-cache-allowed'),
    ...(capability === 'history' ? { intervals: historyIntervals(id) } : {}),
  })),
    { finance: sourceFinancePort(id, finance) });
}

function historyIntervals(sourceId: string): CapabilitySpec['intervals'] {
  return sourceId === 'twelve-data' ? ['1d', '1h', '5m', '1m'] : ['1d'];
}

function profileSource(id: string, name: string, profile: ProviderCompanyProfilePort, markets: MarketCode[], authority: SourceAuthority): SourceInstance {
  return source(id, name, authority === 'regulator' ? 'official' : 'public-api', false, [spec('profile', markets, authority, authority === 'regulator' ? 'A' : 'B', 'public-cache-allowed')], { profile: sourceProfilePort(id, profile) });
}

function financialsSource(id: string, name: string, financials: ProviderFinancialsPort, markets: MarketCode[], authority: SourceAuthority, qualityTier: QualityTier): SourceInstance {
  return source(id, name, authority === 'regulator' ? 'official' : authority === 'official-derived' ? 'derived' : 'public-api', false, [spec('financials', markets, authority, qualityTier, 'public-cache-allowed', 6 * 60 * 60 * 1_000)], { financials: sourceFinancialsPort(id, financials) });
}

function filingsSource(id: string, name: string, filings: ProviderFilingPort, markets: MarketCode[], authority: SourceAuthority, qualityTier: QualityTier): SourceInstance {
  const capabilities = [
    spec('filings', markets, authority, qualityTier, 'public-cache-allowed', 10 * 60 * 1_000),
    ...(filings.getFiling
      ? [spec('filing-document', markets, authority, qualityTier, 'public-cache-allowed', 24 * 60 * 60 * 1_000)]
      : []),
  ];
  return source(id, name, authority === 'regulator' || authority === 'exchange' ? 'official' : 'public-api', false, capabilities, { filings: sourceFilingPort(id, filings) });
}

function macroSource(macro: ProviderMacroPort): SourceInstance {
  return source('official-macro', 'Official macro sources', 'official', false, [{
    ...spec('macro', ['US', 'CN', 'HK'], 'regulator', 'A', 'public-cache-allowed', 60 * 60 * 1_000),
    dataSets: ['macro-series'],
    seriesCodes: [
      'US.GDP.GROWTH.YOY', 'US.CPI.YOY', 'US.UNEMPLOYMENT.RATE',
      'US.POLICY_RATE', 'US.GOVERNMENT_BOND_10Y', 'US.FEDERAL_DEBT',
      'CN.GDP.GROWTH.YOY', 'CN.CPI.YOY', 'CN.UNEMPLOYMENT.RATE',
      'HK.GDP.GROWTH.YOY', 'HK.CPI.YOY', 'HK.UNEMPLOYMENT.RATE',
      'HK.USD_EXCHANGE_RATE', 'HK.INTERBANK_RATE_3M',
    ],
    transport: 'official-api',
  }], { macro: sourceMacroPort('official-macro', macro) });
}

function calendarSource(): SourceInstance {
  return source('market-calendar-rules', 'Market calendar rules', 'derived', false, [spec('market-calendar', ['US', 'CN', 'HK', 'JP', 'UK'], 'derived', 'C', 'public-cache-allowed', 60 * 60 * 1_000)], { marketCalendar: createRuleBasedMarketCalendarPort() });
}

function instrumentSearchSource(id: string, instrumentSearch: ProviderInstrumentSearchPort): SourceInstance {
  return source(id, id, 'public-api', false, [spec('instrument-search', ['US', 'CN', 'HK', 'JP', 'UK'], 'public-api', 'C', 'public-cache-allowed', 60 * 60 * 1_000)], {
    instrumentSearch: sourceInstrumentSearchPort(id, instrumentSearch),
  });
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
    manifest: {
      id,
      name,
      sourceType,
      requiresAuth,
      allowRedistribution: capabilities.every((capability) => capability.redistribution === 'public-cache-allowed'),
      capabilities,
      // This is a process-local concurrency guard, not a claim about a
      // provider plan's request quota. Plan-specific RPS can be configured by plugins.
      rateLimit: { concurrent: id === 'market-calendar-rules' ? 64 : sourceType === 'licensed-vendor' ? 8 : 4 },
    },
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
