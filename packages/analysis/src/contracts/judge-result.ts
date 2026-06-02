import { z } from 'zod';

/**
 * RFC-10 §5.1 — output contract for the selective judge audit applied
 * to COMPREHENSIVE dim outputs.
 *
 * Design rules (see RFC-10 §9 risks for why each one):
 *
 *  - Judge does NOT rewrite the report. It tags concerns, suggests
 *    revisions, and may downgrade confidence. The workflow (TypeScript,
 *    not the LLM) decides what to do with each field.
 *  - `confidenceAdjustment` is the only field that mutates downstream
 *    state — and it can only go DOWN (KEEP / DOWNGRADE_TO_MEDIUM /
 *    DOWNGRADE_TO_LOW). The enum intentionally has no UPGRADE variant
 *    so a prompt-injected judge can never inflate confidence past what
 *    the dim itself reported.
 *  - Array caps (concerns ≤ 8, suggestedRevisions ≤ 5) keep judge
 *    output bounded; bigger lists are usually low-signal padding.
 */
export const JudgeResult = z.object({
  schemaVersion: z.literal('judge-result-v1'),

  /**
   * Overall pass/fail of the audit. `false` ⇒ at least one critical
   * concern (concerns array MUST be non-empty when pass=false). The
   * workflow uses this only for telemetry/UI; the actionable signal
   * is `confidenceAdjustment`.
   */
  pass: z.boolean(),

  /**
   * Specific issues the judge found. Each entry should reference a
   * concrete EvidencePack fact or structuredJson field — no free-form
   * opinion. Empty array when pass=true.
   */
  concerns: z.array(z.string().min(1)).max(8),

  /**
   * Recommended changes (NOT applied automatically). UI may surface as
   * an advisory; an LLM rewrite path is explicitly out of scope for
   * RFC-10. Bounded so the judge doesn't drown the user in suggestions.
   */
  suggestedRevisions: z.array(z.string().min(1)).max(5),

  /**
   * Applied DIRECTLY by the workflow to `dim.structuredJson.conclusion
   * .confidence` before the summary phase runs:
   *   KEEP                — no change
   *   DOWNGRADE_TO_MEDIUM — HIGH → MEDIUM (no-op if already MEDIUM/LOW)
   *   DOWNGRADE_TO_LOW    — any → LOW
   * No UPGRADE variant by design — see file header.
   */
  confidenceAdjustment: z.enum([
    'KEEP',
    'DOWNGRADE_TO_MEDIUM',
    'DOWNGRADE_TO_LOW',
  ]),
});
export type JudgeResult = z.infer<typeof JudgeResult>;
