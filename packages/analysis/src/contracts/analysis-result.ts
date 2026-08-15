import { z } from 'zod';
import { Citation, Evidence } from './citation';
import { Confidence, SectionType } from './enums';
import { OverallConclusion } from './comprehensive-summary';
import { Trace } from './trace';

export const SCHEMA_VERSION = 'analysis-section-v2' as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

const Finding = z.object({
  title: z.string().min(1),
  conclusion: z.string().min(1),
  evidence: z.array(Evidence),
  caveats: z.array(z.string()).optional(),
});
export type Finding = z.infer<typeof Finding>;

const SectionResultBase = z.object({
  schemaVersion: SchemaVersion,
  type: SectionType,
  assessment: z.string().min(1),
  confidence: Confidence,
  summary: z.string().min(1),
  findings: z.array(Finding),
  limitations: z.array(z.string()),
  dataAsOf: z.string().min(1),
  disclaimer: z.string().min(1),
});

const CompanyQualityResult = SectionResultBase.extend({
  type: z.literal('COMPANY_QUALITY'),
  assessment: z.enum(['STRONG', 'MIXED', 'WEAK', 'UNASSESSABLE']),
});

const IndustryResult = SectionResultBase.extend({
  type: z.literal('INDUSTRY_POSITION'),
  assessment: z.enum(['LEADING', 'COMPETITIVE', 'CHALLENGED', 'UNASSESSABLE']),
});

const ValuationResult = SectionResultBase.extend({
  type: z.literal('VALUATION_SCENARIOS'),
  assessment: z.enum(['UNDERVALUED', 'FAIR', 'OVERVALUED', 'UNASSESSABLE']),
  methods: z.array(z.object({
    name: z.string().min(1),
    rationale: z.string().min(1),
    inputs: z.array(z.object({
      name: z.string().min(1),
      value: z.number(),
      unit: z.string().min(1),
      dataAsOf: z.string().min(1),
      evidence: z.array(Evidence),
    })),
  })).default([]),
  scenarios: z.array(z.object({
    case: z.enum(['BEAR', 'BASE', 'BULL']),
    assumptions: z.array(z.string()),
    valueRange: z.object({
      low: z.number(),
      high: z.number(),
      currency: z.string().min(1),
    }).nullable(),
    invalidators: z.array(z.string()),
  })).default([]),
});

const RiskResult = SectionResultBase.extend({
  type: z.literal('RISK_REGISTER'),
  assessment: z.enum(['LOW', 'MEDIUM', 'HIGH', 'UNASSESSABLE']),
  risks: z.array(z.object({
    title: z.string().min(1),
    mechanism: z.string().min(1),
    likelihood: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    impact: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    indicators: z.array(z.string()),
    invalidates: z.array(z.string()),
    evidence: z.array(Evidence),
  })).default([]),
  basedOnIncompleteSections: z.array(SectionType).default([]),
});

const MarketResult = SectionResultBase.extend({
  type: z.literal('MARKET_SIGNALS'),
  assessment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'UNASSESSABLE']),
});

const SectionResultSchema = z.discriminatedUnion('type', [
  CompanyQualityResult,
  IndustryResult,
  ValuationResult,
  RiskResult,
  MarketResult,
]);
export const SectionResult = z.preprocess(
  normalizeSectionCandidate,
  SectionResultSchema,
);
export type SectionResult = z.infer<typeof SectionResultSchema>;
export type StructuredJson = SectionResult;

/**
 * FUNCTIONAL.md (估值): scenario value ranges may only quote code-computed
 * valuation results. When the snapshot carries no computed valuation at all,
 * force every scenario's valueRange to null — the model must not invent
 * price targets, and a prompt rule alone is not an enforcement point.
 */
export function enforceComputedValueRanges<T extends SectionResult>(
  result: T,
  hasComputedValuation: boolean,
): T {
  if (hasComputedValuation || result.type !== 'VALUATION_SCENARIOS') return result;
  return {
    ...result,
    scenarios: result.scenarios.map((scenario) =>
      scenario.valueRange === null
        ? scenario
        : { ...scenario, valueRange: null },
    ),
  } as T;
}

export const AnyStructuredJson = z.union([SectionResult, OverallConclusion]);
export type AnyStructuredJson = z.infer<typeof AnyStructuredJson>;

export const AnalysisResult = z.object({
  reportMarkdown: z.string(),
  structuredJson: AnyStructuredJson.nullable(),
  citations: z.array(Citation),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED']),
  confidence: Confidence,
  trace: Trace,
  warnings: z.array(z.string()),
  partialSections: z.array(SectionType).optional(),
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;

export { Finding, SectionResultBase };

/**
 * Providers sometimes put the explanatory sentence in a risk's enum field
 * (for example `impact: "压缩增长预期"`). The prose report still carries the
 * explanation; normalize only the card-level severity so one malformed field
 * does not fail the entire module.
 */
function normalizeSectionCandidate(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (raw.type !== 'RISK_REGISTER' || !Array.isArray(raw.risks)) return value;
  return {
    ...raw,
    risks: raw.risks.map((risk) => {
      if (!risk || typeof risk !== 'object' || Array.isArray(risk)) return risk;
      const item = risk as Record<string, unknown>;
      return {
        ...item,
        likelihood: normalizeRiskLevel(item.likelihood),
        impact: normalizeRiskLevel(item.impact),
      };
    }),
  };
}

function normalizeRiskLevel(value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' {
  const text = typeof value === 'string' ? value.toUpperCase() : '';
  if (text === 'LOW' || /低|轻微|有限/.test(text)) return 'LOW';
  if (text === 'HIGH' || /高|重大|严重|显著/.test(text)) return 'HIGH';
  return 'MEDIUM';
}
