import type { SourceRateLimit } from '../contracts/source';

/** A deliberately small process-local limiter; deployments can replace it later. */
export class InMemoryRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private readonly inFlight = new Map<string, number>();

  tryAcquire(sourceId: string, limits?: SourceRateLimit, cost = 1): boolean {
    const maxRequests = limits?.maxRequests ?? limits?.requestsPerSecond;
    const windowMs = limits?.maxRequests !== undefined
      ? limits.windowMs
      : limits?.requestsPerSecond !== undefined
        ? 1_000
        : undefined;
    const concurrent = limits?.concurrent;
    const currentInFlight = this.inFlight.get(sourceId) ?? 0;
    if (concurrent && concurrent > 0 && currentInFlight >= concurrent) return false;

    const now = Date.now();
    if (maxRequests && maxRequests > 0 && windowMs && windowMs > 0) {
      const current = this.windows.get(sourceId);
      if (!current || now - current.startedAt >= windowMs) {
        this.windows.set(sourceId, { startedAt: now, count: cost });
      } else {
        if (current.count + cost > maxRequests) return false;
        current.count += cost;
      }
    }

    this.inFlight.set(sourceId, currentInFlight + 1);
    return true;
  }

  release(sourceId: string): void {
    const current = this.inFlight.get(sourceId) ?? 0;
    if (current <= 1) this.inFlight.delete(sourceId);
    else this.inFlight.set(sourceId, current - 1);
  }
}
