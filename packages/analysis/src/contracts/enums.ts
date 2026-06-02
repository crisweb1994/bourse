import { z } from 'zod';
import {
  AnalysisType as SharedAnalysisType,
  Confidence as SharedConfidence,
  Signal as SharedSignal,
} from '@bourse/shared-types';

// ===== Reused from @bourse/shared-types =====
// Wrapped via z.nativeEnum so we get runtime validation without redefining values.

export const AnalysisType = z.nativeEnum(SharedAnalysisType);
export type AnalysisType = z.infer<typeof AnalysisType>;

export const Signal = z.nativeEnum(SharedSignal);
export type Signal = z.infer<typeof Signal>;

export const Confidence = z.nativeEnum(SharedConfidence);
export type Confidence = z.infer<typeof Confidence>;

// ===== Agent-only enums (additions over shared-types) =====

// RunStatus is a SUPERSET of Prisma's AnalysisStatus (6 states) + BUDGET_EXHAUSTED.
// shared-types currently exposes only 4 states; mapping to either layer is the
// integration boundary's responsibility (Day 11 wiring), not this package.
export const RunStatus = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'PARTIAL_FAILED',
  'FAILED',
  'CANCELLED',
  'BUDGET_EXHAUSTED',
]);
export type RunStatus = z.infer<typeof RunStatus>;

// Actionable recommendation, intentionally decoupled from `Signal`.
// signal=BULLISH does NOT imply recommendation=BUY; see MVP doc §9.1.
export const Recommendation = z.enum(['BUY', 'HOLD', 'SELL']);
export type Recommendation = z.infer<typeof Recommendation>;
