import type { Capability, CacheScope, SecurityType } from '../contracts/source';
import type { MarketCode } from '../contracts/instrument';
import type { SourceCandidate } from '../sources/registry';
import { SourceRegistry } from '../sources/registry';
import { InMemorySourceHealth } from '../sources/health';
import type { RoutingPolicy } from './policy';

export interface RouteRequest {
  capability: Capability;
  market: MarketCode;
  input: unknown;
  credentialScope: CacheScope;
  interval?: '1d' | '1h' | '5m' | '1m';
  securityType?: SecurityType;
  signal?: AbortSignal;
  timeoutMs?: number;
  traceId?: string;
  /** Rate-limit weight for a provider batch call. Defaults to one. */
  rateLimitCost?: number;
  /** Canonical id. Only instrument-scoped capabilities populate this field. */
  instrumentId?: string;
}

export interface PlannedCandidate extends SourceCandidate {
  skipReason?: 'DISABLED' | 'AUTH_UNAVAILABLE' | 'POLICY_DISABLED' | 'CIRCUIT_OPEN';
}

export class CapabilityPlanner {
  constructor(
    private readonly registry: SourceRegistry,
    private readonly health: InMemorySourceHealth,
  ) {}

  plan(request: RouteRequest, policy: RoutingPolicy): PlannedCandidate[] {
    const priority = new Map(policy.preferredSources.map((sourceId, index) => [sourceId, index]));
    return this.registry.find(request).map((candidate): PlannedCandidate => {
      const sourceId = candidate.instance.manifest.id;
      const health = this.health.get(sourceId);
      const skipReason: PlannedCandidate['skipReason'] = !candidate.instance.enabled
        ? 'DISABLED'
        : candidate.instance.manifest.requiresAuth && candidate.instance.credentialScope === 'public'
          ? 'AUTH_UNAVAILABLE'
          : policy.disabledSources?.includes(sourceId)
            ? 'POLICY_DISABLED'
            : health.status === 'cooldown'
              ? 'CIRCUIT_OPEN'
              : !qualitySatisfies(candidate.spec.qualityTier, policy.minQualityTier) ||
                  (policy.acceptedDelays !== undefined && (!candidate.spec.delay || !policy.acceptedDelays.includes(candidate.spec.delay)))
                ? 'POLICY_DISABLED'
              : undefined;
      return { ...candidate, skipReason };
    }).sort((left, right) => {
      const leftPriority = priority.get(left.instance.manifest.id) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = priority.get(right.instance.manifest.id) ?? Number.MAX_SAFE_INTEGER;
      if (policy.strategy === 'official-first') {
        const authorityRank = (value: PlannedCandidate) =>
          value.spec.authority === 'regulator' || value.spec.authority === 'exchange' || value.spec.authority === 'official-derived' ? 0 : 1;
        const difference = authorityRank(left) - authorityRank(right);
        if (difference !== 0) return difference;
      }
      return leftPriority - rightPriority;
    });
  }

  diagnoseUnsupported(request: RouteRequest): ReturnType<SourceRegistry['diagnoseUnsupported']> {
    return this.registry.diagnoseUnsupported(request);
  }
}

function qualitySatisfies(actual: 'A' | 'B' | 'C' | 'D' | 'E', minimum: 'A' | 'B' | 'C' | 'D' | 'E' | undefined): boolean {
  if (!minimum) return true;
  return ['A', 'B', 'C', 'D', 'E'].indexOf(actual) <= ['A', 'B', 'C', 'D', 'E'].indexOf(minimum);
}
