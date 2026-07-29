export interface SourceRateLimit {
  requestsPerSecond?: number;
  concurrent?: number;
}

/** A deliberately small process-local limiter; deployments can replace it later. */
export class InMemoryRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private readonly inFlight = new Map<string, number>();

  tryAcquire(sourceId: string, limits?: SourceRateLimit): boolean {
    const requestsPerSecond = limits?.requestsPerSecond;
    const concurrent = limits?.concurrent;
    const currentInFlight = this.inFlight.get(sourceId) ?? 0;
    if (concurrent && concurrent > 0 && currentInFlight >= concurrent) return false;

    const now = Date.now();
    if (requestsPerSecond && requestsPerSecond > 0) {
      const current = this.windows.get(sourceId);
      if (!current || now - current.startedAt >= 1_000) {
        this.windows.set(sourceId, { startedAt: now, count: 1 });
      } else {
        if (current.count >= requestsPerSecond) return false;
        current.count += 1;
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
