import type { ZodSchema } from 'zod';
import type { SectionResult } from '../contracts/analysis-result';
import type { Citation } from '../contracts/citation';
import type { Confidence, FocusWindow, SectionType } from '../contracts/enums';

export const TOOL_NAMES = ['webSearch'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface FreshnessPolicy {
  pricesMaxAgeDays: number;
  newsMaxAgeDays: number;
  financialsRequirement: string;
  staleDataWarningThreshold: string;
  industryReportMaxAgeDays?: number;
}

export interface DimensionInput {
  symbol: string;
  market: string;
  name?: string;
  locale: string;
  question?: string;
  focusWindow?: FocusWindow;
  sectionContext?: string;
}

export interface DimensionRunContext {
  todayDate: string;
}

export interface BuiltPrompts {
  system: string;
  user: string;
}

export interface MultiRoundPlan {
  maxRounds: 2;
  roundPrompts: ReadonlyArray<
    (input: DimensionInput, ctx: DimensionRunContext) => string
  >;
  perRoundToolUses?: number;
}

export interface Dimension<T extends SectionResult = SectionResult> {
  type: SectionType;
  inputSchema: ZodSchema<DimensionInput>;
  buildPrompts(input: DimensionInput, ctx: DimensionRunContext): BuiltPrompts;
  allowedTools: readonly ToolName[];
  /** Runtime schema; the workflow validates the final discriminated result. */
  outputSchema: ZodSchema<any>;
  freshness: FreshnessPolicy;
  onFailure: 'skip';
  multiRoundPlan?: MultiRoundPlan;
  requiresPrivateData?: ReadonlyArray<
    'northboundFlow' | 'lhb' | 'unlockCalendar' | 'consensusEps'
  >;
}

export interface DimensionRunResult<T extends SectionResult = SectionResult> {
  type: SectionType;
  reportMarkdown: string;
  structuredJson: T;
  citations: Citation[];
  confidence: Confidence;
  status: 'COMPLETED' | 'FAILED';
  warnings: string[];
  usage: { tokensIn: number; tokensOut: number };
}
