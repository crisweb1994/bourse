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

/**
 * Shared predicate: does the evidence pack carry a code-computed valuation?
 * Both `enforceComputedValueRanges` callers and the post-chain semantic
 * validator (visualization design §四.④, R-4) MUST derive this from the same
 * function — divergent predicates would let extraction pass while the
 * enforcer still nulls ranges (false-positive acceptance).
 */
export function hasComputedValuationFact(
  computedFacts: { valuation: unknown } | null | undefined,
): boolean {
  return computedFacts != null && computedFacts.valuation != null;
}

export interface ValuationSemantics {
  ok: boolean;
  /** Human-readable gap list; doubles as the semantic-repair prompt input. */
  gaps: string[];
}

/**
 * Post-chain semantic validator for VALUATION_SCENARIOS (design §四.④).
 * Runs AFTER enforceComputedValueRanges so "extraction-time pass, final
 * state still empty" cannot slip through (R-4). Skipped when the module
 * itself declared UNASSESSABLE — empty scenarios are then legitimate
 * degradation, not an extraction failure.
 *
 * Rules (root fix lives in the extraction prompt; this is the rare-path
 * backstop, target trigger rate <10% per acceptance A3):
 *  - scenarios ≥ 1 and ≥ 2 distinct cases including BASE; no duplicate case
 *  - methods ≥ 1
 *  - when the snapshot has a computed valuation: ≥ 1 non-null valueRange
 */
export function validateValuationSemantics(
  result: SectionResult,
  computedValuationPresent: boolean,
): ValuationSemantics {
  if (result.type !== 'VALUATION_SCENARIOS') return { ok: true, gaps: [] };
  if (result.assessment === 'UNASSESSABLE') return { ok: true, gaps: [] };

  const gaps: string[] = [];
  const scenarios = result.scenarios;
  if (scenarios.length === 0) {
    gaps.push('scenarios 为空：至少需要 2 个不同 case（含 BASE）');
  } else {
    const cases = scenarios.map((s) => s.case);
    const distinct = new Set(cases);
    if (distinct.size !== cases.length) {
      gaps.push(`case 重复：${cases.join('、')}`);
    }
    if (!distinct.has('BASE')) {
      gaps.push('缺少 BASE 情景');
    }
    if (distinct.size < 2) {
      gaps.push('至少需要 2 个不同 case 的 scenario');
    }
    if (computedValuationPresent && !scenarios.some((s) => s.valueRange !== null)) {
      gaps.push('快照含代码计算估值时，至少 1 个 scenario 的 valueRange 必须是非 null 数值区间');
    }
  }
  if (result.methods.length === 0) {
    gaps.push('methods 为空：至少 1 项估值方法（name/rationale/inputs）');
  }
  return { ok: gaps.length === 0, gaps };
}

/**
 * Degrade exit (design §四.④ layer 3): keep the legal subset of what the LLM
 * did produce, record the gap as a limitation, never fabricate the missing
 * pieces. Called only when the semantic repair pass still failed.
 */
export function degradeValuationSemantics<T extends SectionResult>(
  result: T,
  gaps: string[],
): T {
  if (result.type !== 'VALUATION_SCENARIOS') return result;
  const seen = new Set<string>();
  const deduped = result.scenarios.filter((s) => {
    if (seen.has(s.case)) return false;
    seen.add(s.case);
    return true;
  });
  return {
    ...result,
    scenarios: deduped,
    limitations: [
      ...result.limitations,
      `情景区间不完整（提取修复未达成）：${gaps.join('；')}`,
    ],
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
