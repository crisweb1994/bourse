/**
 * RFC rfc-evidence-pack-web-search-fallback §1: classify an EvidencePack
 * v2 builder failure to decide whether falling back to the v1 LLM
 * web_search builder is the right call.
 *
 * Decision rules:
 *   - TRANSIENT: gateway already retried; falling back compounds load and
 *     usually self-heals soon. Reject.
 *   - INPUT_INVALID: symbol typo / unsupported market. Fallback can't fix
 *     this. Reject.
 *   - AUTH / NETWORK / RATE_LIMIT_HARD: hard failure that won't self-heal.
 *     Eligible for fallback iff the caller opted in.
 *   - OTHER (unrecognized): treat as eligible to err on the side of
 *     keeping the user's flow alive; UI surfaces the original error.
 *
 * The classifier only reports eligibility; the workflow combines this with
 * the caller's recovery policy.
 */
export type FallbackKind =
  | 'AUTH'
  | 'NETWORK'
  | 'RATE_LIMIT_HARD'
  | 'OTHER';

export interface FallbackEligible {
  eligible: true;
  kind: FallbackKind;
  failedTools: string[];
  message: string;
}
export interface FallbackRejected {
  eligible: false;
  reason: 'TRANSIENT' | 'INPUT_INVALID';
  message: string;
}
export type FallbackDecision = FallbackEligible | FallbackRejected;

/**
 * Structured error shape that ToolMiddleware / EvidencePack v2 builder
 * is expected to attach. Plain `Error` works too — the classifier
 * inspects message patterns as a defensive fallback.
 */
export interface ClassifiableError {
  name?: string;
  message: string;
  kind?: FallbackKind | 'TRANSIENT' | 'INPUT_INVALID';
  failedTools?: string[];
}

export function classifyFallback(err: unknown): FallbackDecision {
  const e = (err ?? {}) as ClassifiableError;
  const msg = e.message ?? String(err);
  const failedTools = e.failedTools ?? [];

  // Structured kind takes precedence.
  if (e.kind === 'TRANSIENT') {
    return { eligible: false, reason: 'TRANSIENT', message: msg };
  }
  if (e.kind === 'INPUT_INVALID') {
    return { eligible: false, reason: 'INPUT_INVALID', message: msg };
  }
  if (e.kind === 'AUTH' || e.kind === 'NETWORK' || e.kind === 'RATE_LIMIT_HARD') {
    return { eligible: true, kind: e.kind, failedTools, message: msg };
  }

  // Message-pattern fallback for legacy errors that don't carry `kind`.
  const lower = msg.toLowerCase();
  if (
    lower.includes('symbol') &&
    (lower.includes('not found') || lower.includes('invalid'))
  ) {
    return { eligible: false, reason: 'INPUT_INVALID', message: msg };
  }
  if (lower.includes('timeout') || lower.includes('econnreset')) {
    // After gateway retry: treat as transient. Workflow rejects.
    return { eligible: false, reason: 'TRANSIENT', message: msg };
  }
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('api key') ||
    lower.includes('apikey')
  ) {
    return { eligible: true, kind: 'AUTH', failedTools, message: msg };
  }
  if (lower.includes('quota') || lower.includes('balance')) {
    return { eligible: true, kind: 'RATE_LIMIT_HARD', failedTools, message: msg };
  }
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('network')
  ) {
    return { eligible: true, kind: 'NETWORK', failedTools, message: msg };
  }

  return { eligible: true, kind: 'OTHER', failedTools, message: msg };
}
