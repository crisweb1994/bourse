import type { SourceManifest, CacheScope } from '../contracts/source';
import type { MarketCalendarPort } from '../ports/market-calendar';
import type { FinancePort, CompanyProfilePort } from '../ports/finance';
import type { FinancialsPort } from '../ports/financials';
import type { FilingPort } from '../ports/filings';
import type { MacroPort } from '../ports/macro';
import type { InstrumentSearchPort } from '../ports/instrument-search';

export interface SourcePorts {
  finance?: FinancePort;
  profile?: CompanyProfilePort;
  financials?: FinancialsPort;
  filings?: FilingPort;
  macro?: MacroPort;
  instrumentSearch?: InstrumentSearchPort;
  marketCalendar?: MarketCalendarPort;
}

export interface SourceConfig {
  enabled?: boolean;
  credentialScope?: CacheScope;
}

export interface SourceRuntime {
  now?: () => Date;
}

export interface SourceInstance {
  manifest: SourceManifest;
  enabled: boolean;
  credentialScope: CacheScope;
  ports: SourcePorts;
}

export interface SourcePlugin<TConfig extends SourceConfig = SourceConfig> {
  manifest: SourceManifest;
  create(config: TConfig, runtime: SourceRuntime): SourceInstance;
}
