import { z } from 'zod';
import {
  ACTIVE_ANALYSIS_TYPES,
  AnalysisType as SharedAnalysisType,
  Confidence as SharedConfidence,
  SECTION_TYPES,
  Signal as SharedSignal,
} from '@bourse/shared-types';

// ===== Reused from @bourse/shared-types =====
// Wrapped via z.nativeEnum so we get runtime validation without redefining values.

export const AnalysisType = z.nativeEnum(SharedAnalysisType);
export type AnalysisType = z.infer<typeof AnalysisType>;

export const ActiveAnalysisType = z.enum(ACTIVE_ANALYSIS_TYPES);
export type ActiveAnalysisType = z.infer<typeof ActiveAnalysisType>;

export const SectionType = z.enum(SECTION_TYPES);
export type SectionType = z.infer<typeof SectionType>;

export const Signal = z.nativeEnum(SharedSignal);
export type Signal = z.infer<typeof Signal>;

export const Confidence = z.nativeEnum(SharedConfidence);
export type Confidence = z.infer<typeof Confidence>;

// ===== Agent-only enums (additions over shared-types) =====

// RunStatus mirrors shared-types/Prisma analysis terminal states while keeping
// the workflow package Prisma-free.
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
