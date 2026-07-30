import type { Capability, CapabilitySpec, DataSet, SecurityType } from '../contracts/source';
import type { SourceFailureCode } from '../contracts/errors';
import type { MarketCode } from '../contracts/instrument';
import type { SourceConfig, SourceInstance, SourcePlugin, SourceRuntime } from './plugin';

export interface SourceLookup {
  capability: Capability;
  market: MarketCode;
  dataSet?: DataSet;
  seriesCode?: string;
  interval?: '1d' | '1h' | '5m' | '1m';
  securityType?: SecurityType;
}

export interface SourceCandidate {
  instance: SourceInstance;
  spec: CapabilitySpec;
}

export class SourceRegistry {
  private readonly sources = new Map<string, SourceInstance>();

  constructor(instances: readonly SourceInstance[] = []) {
    for (const instance of instances) this.register(instance);
  }

  register(instance: SourceInstance): void {
    if (this.sources.has(instance.manifest.id)) {
      throw new Error(`Duplicate market-data source: ${instance.manifest.id}`);
    }
    validateSourceInstance(instance);
    this.sources.set(instance.manifest.id, instance);
  }

  registerPlugin<TConfig extends SourceConfig>(
    plugin: SourcePlugin<TConfig>,
    config: TConfig,
    runtime: SourceRuntime = {},
  ): SourceInstance {
    const instance = plugin.create(config, runtime);
    if (instance.manifest.id !== plugin.manifest.id) {
      throw new Error(`Source plugin ${plugin.manifest.id} created mismatched source ${instance.manifest.id}.`);
    }
    this.register(instance);
    return instance;
  }

  get(sourceId: string): SourceInstance | undefined {
    return this.sources.get(sourceId);
  }

  all(): SourceInstance[] {
    return [...this.sources.values()];
  }

  find(lookup: SourceLookup): SourceCandidate[] {
    return this.all().flatMap((instance): SourceCandidate[] => {
      const spec = instance.manifest.capabilities.find((candidate) =>
        candidate.capability === lookup.capability &&
        candidate.markets.includes(lookup.market) &&
        (!lookup.dataSet || candidate.dataSets?.includes(lookup.dataSet)) &&
        (!lookup.seriesCode || candidate.seriesCodes?.includes(lookup.seriesCode)) &&
        (!lookup.interval || !candidate.intervals || candidate.intervals.includes(lookup.interval)) &&
        (!lookup.securityType || !candidate.securityTypes || candidate.securityTypes.includes(lookup.securityType)),
      );
      return spec ? [{ instance, spec }] : [];
    });
  }

  diagnoseUnsupported(lookup: SourceLookup): SourceFailureCode | undefined {
    const capabilityMatches = this.all().flatMap((instance) =>
      instance.manifest.capabilities
        .filter((spec) => spec.capability === lookup.capability)
        .map((spec) => ({ instance, spec })),
    );
    if (capabilityMatches.length === 0) return 'UNSUPPORTED_CAPABILITY';

    const marketMatches = capabilityMatches.filter(({ spec }) => spec.markets.includes(lookup.market));
    if (marketMatches.length === 0) return 'UNSUPPORTED_MARKET';

    const dataSetMatches = lookup.dataSet
      ? marketMatches.filter(({ spec }) => spec.dataSets?.includes(lookup.dataSet!))
      : marketMatches;
    if (lookup.dataSet && dataSetMatches.length === 0) return 'UNSUPPORTED_DATASET';

    const seriesMatches = lookup.seriesCode
      ? dataSetMatches.filter(({ spec }) => spec.seriesCodes?.includes(lookup.seriesCode!))
      : dataSetMatches;
    if (lookup.seriesCode && seriesMatches.length === 0) return 'UNSUPPORTED_SERIES';

    const securityMatches = lookup.securityType
      ? seriesMatches.filter(({ spec }) => !spec.securityTypes || spec.securityTypes.includes(lookup.securityType!))
      : seriesMatches;
    if (lookup.securityType && securityMatches.length === 0) return 'UNSUPPORTED_SECURITY_TYPE';

    const intervalMatches = lookup.interval
      ? securityMatches.filter(({ spec }) => !spec.intervals || spec.intervals.includes(lookup.interval!))
      : securityMatches;
    if (lookup.interval && intervalMatches.length === 0) return 'UNSUPPORTED_INTERVAL';
    return undefined;
  }
}

function validateSourceInstance(instance: SourceInstance): void {
  if (!instance.manifest.id.trim()) throw new Error('Market-data source id must not be empty.');
  if (!Number.isInteger(instance.manifest.rateLimit.concurrent) || instance.manifest.rateLimit.concurrent <= 0) {
    throw new Error(`Source ${instance.manifest.id} must declare a positive concurrent rate limit.`);
  }
  for (const spec of instance.manifest.capabilities) {
    if (!implementsCapability(instance, spec.capability)) {
      throw new Error(`Source ${instance.manifest.id} declares ${spec.capability} but does not implement its canonical port.`);
    }
  }
}

function implementsCapability(instance: SourceInstance, capability: Capability): boolean {
  switch (capability) {
    case 'quote': return typeof instance.ports.finance?.getQuote === 'function';
    case 'history': return typeof instance.ports.finance?.getHistory === 'function';
    case 'profile': return typeof instance.ports.profile?.getProfile === 'function' || typeof instance.ports.finance?.getProfile === 'function';
    case 'earnings-consensus': return typeof instance.ports.finance?.fetchEarningsConsensus === 'function';
    case 'financials': return typeof instance.ports.financials?.fetchFinancials === 'function';
    case 'filings': return typeof instance.ports.filings?.searchFilings === 'function';
    case 'filing-document': return typeof instance.ports.filings?.getFiling === 'function';
    case 'macro': return typeof instance.ports.macro?.fetchMacro === 'function';
    case 'instrument-search': return typeof instance.ports.instrumentSearch?.search === 'function';
    case 'market-calendar': return typeof instance.ports.marketCalendar?.getMarketSession === 'function';
    case 'corporate-actions': return typeof instance.ports.corporateActions?.listActions === 'function';
    case 'ownership': return typeof instance.ports.ownership?.listOwnership === 'function';
    case 'market-events': return typeof instance.ports.marketEvents?.listEvents === 'function';
  }
}
