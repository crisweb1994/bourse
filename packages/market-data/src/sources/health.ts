import type { SourceFailureCode } from '../contracts/errors';

export interface SourceHealth {
  sourceId: string;
  status: 'healthy' | 'degraded' | 'cooldown' | 'disabled';
  recentSuccess: number;
  recentFailure: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureCode?: SourceFailureCode;
  cooldownUntil?: string;
}

export class InMemorySourceHealth {
  private readonly records = new Map<string, SourceHealth>();

  constructor(
    private readonly failureThreshold = 3,
    private readonly cooldownMs = 30_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(sourceId: string): SourceHealth {
    const current = this.records.get(sourceId) ?? {
      sourceId,
      status: 'healthy' as const,
      recentSuccess: 0,
      recentFailure: 0,
    };
    if (current.status === 'cooldown' && current.cooldownUntil && Date.parse(current.cooldownUntil) <= this.now().getTime()) {
      const next = { ...current, status: 'degraded' as const, recentFailure: 0, cooldownUntil: undefined };
      this.records.set(sourceId, next);
      return next;
    }
    return current;
  }

  recordSuccess(sourceId: string): void {
    const now = this.now().toISOString();
    const current = this.get(sourceId);
    this.records.set(sourceId, {
      ...current,
      status: 'healthy',
      recentSuccess: current.recentSuccess + 1,
      recentFailure: 0,
      lastSuccessAt: now,
      cooldownUntil: undefined,
    });
  }

  recordFailure(sourceId: string, code: SourceFailureCode): void {
    const current = this.get(sourceId);
    const transient = isTransientSourceFailure(code);
    const failures = transient ? current.recentFailure + 1 : current.recentFailure;
    const cooldown = transient && failures >= this.failureThreshold;
    this.records.set(sourceId, {
      ...current,
      status: cooldown ? 'cooldown' : transient ? 'degraded' : current.status,
      recentFailure: failures,
      lastFailureAt: this.now().toISOString(),
      lastFailureCode: code,
      ...(cooldown ? { cooldownUntil: new Date(this.now().getTime() + this.cooldownMs).toISOString() } : {}),
    });
  }
}

export function isTransientSourceFailure(code: SourceFailureCode): boolean {
  return [
    'RATE_LIMITED',
    'TIMEOUT',
    'NETWORK_ERROR',
    'SOURCE_UNAVAILABLE',
    'INVALID_PAYLOAD',
    'NORMALIZATION_FAILED',
    'VALIDATION_FAILED',
  ].includes(code);
}
