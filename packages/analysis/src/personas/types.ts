/**
 * MVP doc §3.2: persona = an investment style, NOT a celebrity roleplay.
 * Only the neutral judge (`judgeNeutral`) survives the DEBATE removal;
 * the 6 investor personas + their style/bias taxonomy are gone.
 */
export interface Persona {
  /** Business alias used in `personas.xxx` lookups. */
  id: string;
  /** Display name shown in UI (not used by prompts). */
  displayName: string;
  /** Internal style enum. */
  style: 'ANALYTICAL_JUDGE';
  /** Role marker; only the neutral judge remains after the DEBATE removal. */
  bias: 'judge';
  /**
   * Free-form description of the lens this style applies, injected into the
   * judge's system prompt. Keep it focused on *what to analyze*, not on *who*
   * (no celebrity quotes / no "if I were X" framing).
   */
  styleDescription: string;
  /** Dimensions where this style adds value (informational; not enforced). */
  favoredDimensions: readonly string[];
  /** Dimensions where this style is weak / should be avoided. */
  weakDimensions: readonly string[];
}
