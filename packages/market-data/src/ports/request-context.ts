import type { CacheScope } from '../contracts/source';
import type { ResolvedInstrument } from '../sources/resolver';

/** Runtime-only context. Credentials are held by a source instance, never here. */
export interface SourceRequestContext {
  signal?: AbortSignal;
  timeoutMs: number;
  credentialScope: CacheScope;
  traceId: string;
  now: () => Date;
  /** Source-specific symbol mapping resolved by the router. */
  resolvedInstrument?: ResolvedInstrument;
}
