import { Injectable } from '@nestjs/common';

/**
 * In-process registry of currently-running analyses keyed by analysisId.
 *
 * The runner registers an `AbortController` when it starts a run and releases
 * it when the generator settles. The command service's `abort()` calls
 * `abort(id)` to interrupt the in-flight generator (which has the signal
 * threaded through to the provider SDK) — turning the "stop" button from a
 * pure SSE-disconnect into a real backend cancellation.
 *
 * Scope: single-instance OSS deployment only. A multi-replica setup would
 * need a distributed handle (DB lease / pub-sub); out of scope here.
 */
@Injectable()
export class AnalysisRunRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(id: string, controller: AbortController): void {
    this.controllers.set(id, controller);
  }

  release(id: string): void {
    this.controllers.delete(id);
  }

  /** Trigger the in-flight generator's AbortSignal. No-op if not running. */
  abort(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  /** Test/diagnostic helper. */
  isRunning(id: string): boolean {
    const controller = this.controllers.get(id);
    return !!controller && !controller.signal.aborted;
  }
}
