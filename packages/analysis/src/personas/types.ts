export interface Persona {
  /** Business alias for the judge profile. */
  id: string;
  /** Display name shown in diagnostics (not used by prompts). */
  displayName: string;
  /** Internal style enum. */
  style: 'ANALYTICAL_JUDGE';
  /** Role marker. */
  bias: 'judge';
  /**
   * Free-form description of the audit lens injected into the judge's system
   * prompt. Keep it focused on evidence checks, not personality.
   */
  styleDescription: string;
  /** Dimensions where this style adds value (informational; not enforced). */
  favoredDimensions: readonly string[];
  /** Dimensions where this style is weak / should be avoided. */
  weakDimensions: readonly string[];
}
