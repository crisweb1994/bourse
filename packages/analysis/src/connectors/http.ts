/**
 * Shared HTTP rituals for connectors.
 *
 * Every connector that talks to an upstream repeats the same three steps:
 *   1. resolve a FetchLike (ctx override → options override → global fetch),
 *   2. run the fetch under an AbortController + timeout (honoring ctx.signal),
 *   3. on failure, build a uniform ResearchResult envelope (data sentinel +
 *      stale freshness + single warning).
 *
 * These helpers own that boilerplate so connectors keep only their URL-building
 * + parsing logic. Behavior is byte-for-byte what the inlined copies produced.
 */
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../contracts/result';
import type { ResearchWarning } from '../contracts/warning';
import type { ConnectorRunContext, FetchLike } from './types';

/** Options shape accepted by `resolveFetch`/`withTimeout`. Both fields optional. */
export interface HttpResolveOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
}

/**
 * Resolve the FetchLike to use for a request.
 *
 * Precedence (highest first): per-request `ctx.fetchLike`, connector-level
 * `options.fetchLike`, then the global `fetch`. The yahoo connector has no
 * `options.fetchLike` — call with `{}` (or omit) to get the 2-way variant.
 */
export function resolveFetch(
  ctx: ConnectorRunContext,
  options: HttpResolveOptions = {},
): FetchLike {
  return ctx.fetchLike ?? options.fetchLike ?? (globalThis.fetch as unknown as FetchLike);
}

/**
 * Run `fn(signal)` under an AbortController + timeout.
 *
 * Owns the `new AbortController()` + `setTimeout(abort, timeoutMs)` +
 * `signal = ctx.signal ?? controller.signal` + `finally clearTimeout` ritual.
 * The caller's `signal` (when `ctx.signal` is set) is forwarded so an external
 * abort still propagates; otherwise the internal timeout drives the abort.
 *
 * `timeoutMs` is resolved by the caller because connectors disagree on the
 * source (some read `ctx.timeoutMs ?? options.timeoutMs ?? DEFAULT`, eastmoney
 * + tavily resolve `options.timeoutMs ?? DEFAULT` once at construction).
 */
export async function withTimeout<T>(
  ctx: ConnectorRunContext,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = ctx.signal ?? controller.signal;
  try {
    return await fn(signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a uniform failure envelope.
 *
 * The empty-`data` sentinel differs per connector (`[]`, `null`, an
 * `emptyQuote()` value) and so MUST be supplied by the caller. Everything else
 * — schemaVersion, empty citations, a single stale freshness marker keyed on
 * `provider`, and one warning — is identical across connectors.
 */
export function failure<T>(
  provider: string,
  data: T,
  args: {
    retrievedAt: string;
    code: ResearchWarning['code'];
    message: string;
    cause?: string;
  },
): ResearchResult<T> {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    data,
    citations: [],
    freshness: [
      {
        provider,
        asOf: args.retrievedAt,
        retrievedAt: args.retrievedAt,
        stale: true,
        reason: args.message,
      },
    ],
    warnings: [
      {
        code: args.code,
        message: args.message,
        provider,
        ...(args.cause ? { cause: args.cause } : {}),
      },
    ],
  };
}
