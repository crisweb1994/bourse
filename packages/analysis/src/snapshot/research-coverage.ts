import { z } from 'zod';
import type { SectionType } from '../contracts/enums';
import type { StructuredJson } from '../contracts/analysis-result';

const SECTION_TYPES = [
  'FUNDAMENTAL',
  'GOVERNANCE',
  'VALUATION',
  'INDUSTRY',
  'RISK',
  'TECHNICAL',
  'SENTIMENT',
  'SCENARIO',
  'PORTFOLIO',
] as const;

export const ResearchCoverageStatusSchema = z.enum([
  'PASS',
  'DEGRADED',
  'INSUFFICIENT_EVIDENCE',
]);
export type ResearchCoverageStatus = z.infer<typeof ResearchCoverageStatusSchema>;

export const ResearchDimensionCoverageSchema = z.object({
  sectionType: z.enum(SECTION_TYPES),
  status: ResearchCoverageStatusSchema,
  minimumViable: z.boolean(),
  confidenceCap: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  missingCriticalFacts: z.array(z.string()),
  staleFacts: z.array(z.string()),
  blockedClaims: z.array(z.string()),
  skip: z.boolean(),
});
export type ResearchDimensionCoverage = z.infer<
  typeof ResearchDimensionCoverageSchema
>;

export const ResearchCoverageSchema = z.object({
  overallStatus: ResearchCoverageStatusSchema,
  overallConfidenceCap: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  dimensions: z.record(z.enum(SECTION_TYPES), ResearchDimensionCoverageSchema),
});
export type ResearchCoverage = z.infer<typeof ResearchCoverageSchema>;

interface CoverageRule {
  allOf?: readonly string[];
  anyOf?: readonly string[];
  degradedBlockedClaims?: readonly string[];
  alwaysBlockedClaims?: readonly string[];
  skipWhenInsufficient?: boolean;
}

const RULES: Record<SectionType, CoverageRule> = {
  FUNDAMENTAL: {
    allOf: ['financials'],
    degradedBlockedClaims: ['精确财务趋势、ROIC 或现金流质量结论'],
  },
  GOVERNANCE: {
    allOf: ['filings'],
    degradedBlockedClaims: ['治理质量评级、股权结构比例或高管交易结论'],
  },
  VALUATION: {
    allOf: ['quote', 'financials'],
    degradedBlockedClaims: ['DCF、反向 DCF、精确目标价或精确估值区间'],
  },
  INDUSTRY: {
    allOf: ['profile'],
    degradedBlockedClaims: ['公司市场份额、行业排名或精确竞争地位'],
  },
  RISK: {
    anyOf: ['financials', 'filings', 'macro'],
    degradedBlockedClaims: ['量化损失幅度、偿债风险或宏观敏感度结论'],
  },
  TECHNICAL: {
    allOf: ['quote', 'history'],
    degradedBlockedClaims: ['趋势、支撑阻力、均线、RSI、MACD 或成交量结论'],
    skipWhenInsufficient: true,
  },
  SENTIMENT: {
    allOf: ['quote'],
    degradedBlockedClaims: ['资金净流入、分析师共识、内部人交易或做空比例结论'],
  },
  SCENARIO: {
    allOf: ['quote', 'financials', 'macro'],
    degradedBlockedClaims: ['情景目标价、概率分配或精确财务敏感性'],
  },
  PORTFOLIO: {
    allOf: ['quote', 'history'],
    degradedBlockedClaims: ['波动率、Beta 或相关性结论'],
    alwaysBlockedClaims: ['个性化仓位百分比、与现有持仓的相关性或组合边际风险'],
  },
};

const CONFIDENCE_RANK: Record<'HIGH' | 'MEDIUM' | 'LOW', number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

/**
 * Turn snapshot field availability into the small set of hard research rules
 * that every dimension shares. This intentionally stays static and local: no
 * planner, database registry, or per-source orchestration layer is needed.
 */
export function buildResearchCoverage(
  availableFields: ReadonlySet<string>,
  staleFields: ReadonlySet<string> = new Set(),
): ResearchCoverage {
  const dimensions = Object.fromEntries(
    SECTION_TYPES.map((sectionType) => [
      sectionType,
      evaluateRule(sectionType, RULES[sectionType], availableFields, staleFields),
    ]),
  ) as ResearchCoverage['dimensions'];

  const core = [
    dimensions.FUNDAMENTAL!,
    dimensions.VALUATION!,
  ];
  const coreFailures = core.filter((item) => !item.minimumViable).length;
  const highConfidenceFacts = ['quote', 'history', 'financials', 'filings', 'macro']
    .every((field) => availableFields.has(field) && !staleFields.has(field));

  return {
    overallStatus:
      coreFailures > 0
        ? 'INSUFFICIENT_EVIDENCE'
      : Object.values(dimensions).some((item) => item.status === 'DEGRADED')
          ? 'DEGRADED'
          : 'PASS',
    overallConfidenceCap:
      coreFailures > 0 ? 'LOW' : highConfidenceFacts ? 'HIGH' : 'MEDIUM',
    dimensions,
  };
}

export function shouldSkipForCoverage(
  coverage: ResearchCoverage | undefined,
  sectionType: SectionType,
): ResearchDimensionCoverage | undefined {
  const decision = coverage?.dimensions[sectionType];
  return decision?.skip ? decision : undefined;
}

/**
 * Apply code-side coverage decisions after structured output parsing.
 *
 * The model extracts presentation data from the report, but it is not the
 * authority on whether a required fact is missing. Without this override it
 * tends to list every optional metric mentioned by a prompt, which makes a
 * complete evidence pack look degraded in the UI.
 */
export function applyResearchCoverage<T extends StructuredJson>(
  data: T,
  coverage: ResearchDimensionCoverage | undefined,
): T {
  if (!coverage) return data;

  const current = data.conclusion.confidence;
  const capped =
    CONFIDENCE_RANK[current] > CONFIDENCE_RANK[coverage.confidenceCap]
      ? coverage.confidenceCap
      : current;
  const missingFields = [...new Set(coverage.missingCriticalFacts)];
  const reasonParts = [data.dataAvailability.reason];
  if (coverage.status !== 'PASS') {
    reasonParts.push(
      `研究覆盖度 ${coverage.status}: ${coverage.missingCriticalFacts.join(', ') || '建议数据不足'}`,
    );
  }

  const next: StructuredJson = {
    ...data,
    conclusion: { ...data.conclusion, confidence: capped },
    dataAvailability: {
      ...data.dataAvailability,
      missingFields,
      reason: reasonParts.filter(Boolean).join('；'),
    },
  };

  if (coverage.blockedClaims.some((claim) => claim.includes('目标价'))) {
    delete next.priceTarget;
  }
  return next as T;
}

function evaluateRule(
  sectionType: SectionType,
  rule: CoverageRule,
  available: ReadonlySet<string>,
  staleFields: ReadonlySet<string>,
): ResearchDimensionCoverage {
  const missingAll = (rule.allOf ?? []).filter((field) => !available.has(field));
  const anyOf = rule.anyOf ?? [];
  const missingAny =
    anyOf.length > 0 && !anyOf.some((field) => available.has(field))
      ? anyOf
      : [];
  const missingCriticalFacts = [...new Set([...missingAll, ...missingAny])];
  const minimumViable = missingCriticalFacts.length === 0;
  const requiredFields = [...new Set([...(rule.allOf ?? []), ...(rule.anyOf ?? [])])];
  const staleFacts = requiredFields.filter(
    (field) => available.has(field) && staleFields.has(field),
  );
  const status: ResearchCoverageStatus = !minimumViable
    ? 'INSUFFICIENT_EVIDENCE'
    : staleFacts.length > 0
      ? 'DEGRADED'
      : 'PASS';

  return {
    sectionType,
    status,
    minimumViable,
    confidenceCap: !minimumViable ? 'LOW' : staleFacts.length > 0 ? 'MEDIUM' : 'HIGH',
    missingCriticalFacts,
    staleFacts,
    blockedClaims: [
      ...(status === 'PASS' ? [] : rule.degradedBlockedClaims ?? []),
      ...(rule.alwaysBlockedClaims ?? []),
    ],
    skip: !minimumViable && rule.skipWhenInsufficient === true,
  };
}
