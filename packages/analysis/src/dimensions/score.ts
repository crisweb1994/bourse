import type { Confidence, Signal } from '../contracts/enums';

/**
 * Default 0-100 score lookup by Signal × Confidence.
 *
 * Symmetric around NEUTRAL+MEDIUM=50. Used by walking-skeleton dimensions;
 * Wave 5 may swap in weighted/multi-factor scoring per dimension.
 */
const TABLE: Record<`${Signal}-${Confidence}`, number> = {
  'BULLISH-HIGH': 85,
  'BULLISH-MEDIUM': 70,
  'BULLISH-LOW': 60,
  'NEUTRAL-HIGH': 55,
  'NEUTRAL-MEDIUM': 50,
  'NEUTRAL-LOW': 45,
  'BEARISH-LOW': 40,
  'BEARISH-MEDIUM': 30,
  'BEARISH-HIGH': 15,
};

export function defaultScore(signal: Signal, confidence: Confidence): number {
  return TABLE[`${signal}-${confidence}`];
}
