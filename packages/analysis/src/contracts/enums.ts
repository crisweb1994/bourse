import { z } from 'zod';
import {
  ANALYSIS_MODES,
  FOCUS_WINDOWS,
  SECTION_TYPES,
  AnalysisStatus as SharedAnalysisStatus,
  Confidence as SharedConfidence,
  OverallSignal as SharedOverallSignal,
  SectionStatus as SharedSectionStatus,
} from '@bourse/shared-types';

export const AnalysisMode = z.enum(ANALYSIS_MODES);
export type AnalysisMode = z.infer<typeof AnalysisMode>;

export const FocusWindow = z.enum(FOCUS_WINDOWS);
export type FocusWindow = z.infer<typeof FocusWindow>;

export const SectionType = z.enum(SECTION_TYPES);
export type SectionType = z.infer<typeof SectionType>;

export const SectionStatus = z.nativeEnum(SharedSectionStatus);
export type SectionStatus = z.infer<typeof SectionStatus>;

export const AnalysisStatus = z.nativeEnum(SharedAnalysisStatus);
export type AnalysisStatus = z.infer<typeof AnalysisStatus>;

export const OverallSignal = z.nativeEnum(SharedOverallSignal);
export type OverallSignal = z.infer<typeof OverallSignal>;

export const Confidence = z.nativeEnum(SharedConfidence);
export type Confidence = z.infer<typeof Confidence>;

export const RunStatus = AnalysisStatus;
export type RunStatus = AnalysisStatus;
