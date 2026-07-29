import type { Capability, CapabilitySpec, SecurityType } from '../contracts/source';
import type { MarketCode } from '../contracts/instrument';
import type { SourceConfig, SourceInstance, SourcePlugin, SourceRuntime } from './plugin';

export interface SourceLookup {
  capability: Capability;
  market: MarketCode;
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
    this.sources.set(instance.manifest.id, instance);
  }

  registerPlugin<TConfig extends SourceConfig>(
    plugin: SourcePlugin<TConfig>,
    config: TConfig,
    runtime: SourceRuntime = {},
  ): SourceInstance {
    const instance = plugin.create(config, runtime);
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
        (!lookup.interval || !candidate.intervals || candidate.intervals.includes(lookup.interval)) &&
        (!lookup.securityType || !candidate.securityTypes || candidate.securityTypes.includes(lookup.securityType)),
      );
      return spec ? [{ instance, spec }] : [];
    });
  }
}
