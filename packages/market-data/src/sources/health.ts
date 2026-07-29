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

  constructor(private readonly failureThreshold = 3, private readonly cooldownMs = 30_000) {}

  get(sourceId: string): SourceHealth {
    const current = this.records.get(sourceId) ?? {
      sourceId,
      status: 'healthy' as const,
      recentSuccess: 0,
      recentFailure: 0,
    };
    if (current.status === 'cooldown' && current.cooldownUntil && Date.parse(current.cooldownUntil) <= Date.now()) {
      const next = { ...current, status: 'degraded' as const, recentFailure: 0, cooldownUntil: undefined };
      this.records.set(sourceId, next);
      return next;
    }
    return current;
  }

  recordSuccess(sourceId: string): void {
    const now = new Date().toISOString();
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
    const failures = current.recentFailure + 1;
    const cooldown = failures >= this.failureThreshold && code !== 'AUTH_REQUIRED' && code !== 'UNSUPPORTED_MARKET';
    this.records.set(sourceId, {
      ...current,
      status: cooldown ? 'cooldown' : 'degraded',
      recentFailure: failures,
      lastFailureAt: new Date().toISOString(),
      lastFailureCode: code,
      ...(cooldown ? { cooldownUntil: new Date(Date.now() + this.cooldownMs).toISOString() } : {}),
    });
  }
}
