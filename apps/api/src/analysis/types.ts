/**
 * Shared types for the analysis module. Kept separate from the service files
 * so that cross-cutting type imports (e.g. the adapter, scenario runner) don't
 * create a dependency on `analysis.service.ts` (the CRUD service).
 */

/**
 * SSE emit callback: `(eventName, payload) => void`. Used by `runAnalysis` to
 * stream events to the SSE client, and by the replay paths to re-emit stored
 * state on reconnect.
 */
export interface SseCallback {
  (event: string, data: unknown): void;
}
