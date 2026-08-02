import { Prisma, type Filing } from '@prisma/client';
import {
  attachComparisons,
  EarningsManagementClaimCandidateSchema,
  type EarningsCardPayload,
  type EarningsFilingDescriptor,
  type MetricFact,
} from '@bourse/analysis';
import type { PreparedEarningsSource } from './earnings-source.service';

export function mergeEarningsCardPayload(
  current: EarningsCardPayload,
  candidate: EarningsCardPayload,
  relationType: 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES',
): EarningsCardPayload {
  const currentFiles = [current.filing, ...current.supportingFilings].map((filing) => ({
    ...filing,
    relationType: filing.relationType ?? relationType,
  }));
  const candidateFile = { ...candidate.filing, relationType };
  const files = [...currentFiles, candidateFile].filter((filing, index, all) => {
    const key = filing.filingId ?? `${filing.sourceUrl}:${filing.publishedAt}`;
    return all.findIndex((other) => (other.filingId ?? `${other.sourceUrl}:${other.publishedAt}`) === key) === index;
  });
  const primary = choosePrimaryFiling(current.filing, candidateFile, relationType);
  const primaryKey = primary.filingId ?? `${primary.sourceUrl}:${primary.publishedAt}`;
  const supportingFilings = files.filter((filing) => (filing.filingId ?? `${filing.sourceUrl}:${filing.publishedAt}`) !== primaryKey);

  const facts = new Map<string, MetricFact>();
  for (const fact of current.facts) facts.set(factIdentity(fact), fact);
  for (const fact of candidate.facts) {
    const key = factIdentity(fact);
    const previous = facts.get(key);
    if (!previous || shouldReplaceFact(previous, fact, current, candidate, relationType)) {
      facts.set(key, fact);
    }
  }
  const comparisonBase = [...facts.values()].map((fact) => ({
    ...fact,
    comparisons: fact.comparisons.filter((comparison) => comparison.kind !== 'PREVIOUS_VERSION'),
  }));
  const mergedFacts = attachComparisons(comparisonBase, current.facts, 'PREVIOUS_VERSION').map((fact) => ({
    ...fact,
    comparisons: fact.comparisons.filter((comparison) => (
      comparison.kind !== 'PREVIOUS_VERSION'
      || comparison.referenceValue?.kind === 'range'
      || comparison.absoluteDelta !== '0'
    )),
  }));
  const claims = [...current.managementClaims, ...candidate.managementClaims]
    .filter((claim, index, all) => all.findIndex((other) => other.id === claim.id) === index);
  return {
    ...candidate,
    filing: primary,
    supportingFilings,
    facts: mergedFacts,
    managementClaims: claims,
    omittedFactCount: Math.max(current.omittedFactCount, candidate.omittedFactCount),
    statusSummary: summarizeFacts(mergedFacts),
  };
}

function choosePrimaryFiling(
  current: EarningsFilingDescriptor,
  candidate: EarningsFilingDescriptor,
  relationType: 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES',
): EarningsFilingDescriptor {
  if (relationType === 'CORRECTS' || relationType === 'SUPERSEDES') return candidate;
  const currentRank = filingAuthorityRank(current);
  const candidateRank = filingAuthorityRank(candidate);
  if (candidateRank > currentRank) return candidate;
  if (candidateRank === currentRank && new Date(candidate.publishedAt).getTime() > new Date(current.publishedAt).getTime()) {
    return candidate;
  }
  return current;
}

function shouldReplaceFact(
  previous: MetricFact,
  candidate: MetricFact,
  current: EarningsCardPayload,
  next: EarningsCardPayload,
  relationType: 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES',
): boolean {
  if (relationType === 'CORRECTS' || relationType === 'SUPERSEDES') return true;
  const previousFiling = filingForFact(current, previous);
  const candidateFiling = filingForFact(next, candidate);
  return filingAuthorityRank(candidateFiling) >= filingAuthorityRank(previousFiling);
}

function filingForFact(payload: EarningsCardPayload, fact: MetricFact): EarningsFilingDescriptor {
  const provenance = fact.provenance;
  if (provenance.kind !== 'filingSpan') return payload.filing;
  return [payload.filing, ...payload.supportingFilings].find((filing) => filing.filingId === provenance.filingId)
    ?? payload.filing;
}

function filingAuthorityRank(filing: EarningsFilingDescriptor): number {
  const form = filing.formType.toLowerCase();
  if (filing.relationType === 'CORRECTS') return 100;
  if (form === '10-k') return 90;
  if (form === '10-q') return 80;
  if (form === '8-k') return 60;
  if (form === 'preliminary') return 50;
  if (form === 'preview') return 40;
  return 30;
}

function factIdentity(fact: MetricFact): string {
  return JSON.stringify([
    fact.metricCode,
    fact.accumulation === 'discrete' ? undefined : fact.periodStartOn,
    fact.periodEndOn,
    fact.periodKind,
    fact.accumulation,
    fact.accountingBasis,
    fact.consolidationScope,
    fact.unit,
    fact.currency,
  ]);
}

export function parseSourceDescriptor(value: Prisma.JsonValue): PreparedEarningsSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_SOURCE_DESCRIPTOR');
  }
  const source = value as Record<string, unknown>;
  const required = ['provider', 'sourceDocumentId', 'formType', 'sourceUrl', 'publishedAt', 'filingId', 'derivationId'];
  if (source.kind !== 'filing' || required.some((key) => typeof source[key] !== 'string' || !source[key])) {
    throw new Error('INVALID_SOURCE_DESCRIPTOR');
  }
  if (source.expectedPeriodEndOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(source.expectedPeriodEndOn))) {
    throw new Error('INVALID_SOURCE_DESCRIPTOR');
  }
  return source as unknown as PreparedEarningsSource;
}

export function parsePages(value: Prisma.JsonValue | null): PreparedEarningsSource['pages'] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const page = item as Record<string, unknown>;
    return typeof page.page === 'number' && typeof page.startOffset === 'number' && typeof page.endOffset === 'number'
      ? [{ page: page.page, text: typeof page.text === 'string' ? page.text : '', startOffset: page.startOffset, endOffset: page.endOffset }]
      : [];
  });
}

function summarizeFacts(facts: MetricFact[]) {
  return facts.reduce(
    (summary, fact) => {
      summary.total += 1;
      if (fact.provenance.kind === 'structuredSource') summary.structuredOnly += 1;
      if (fact.reconcileStatus.status === 'reconciled') summary.reconciled += 1;
      if (fact.reconcileStatus.status === 'pending') summary.pending += 1;
      if (fact.reconcileStatus.status === 'conflicted') summary.conflicted += 1;
      return summary;
    },
    { total: 0, reconciled: 0, pending: 0, conflicted: 0, structuredOnly: 0 },
  );
}

export function decideFilingRelation(
  filing: Pick<Filing, 'formType' | 'title'>,
  existing: Array<Pick<Filing, 'formType' | 'title'>>,
): 'SUPPLEMENTS' | 'CORRECTS' | 'SUPERSEDES' {
  if (/\/A$/i.test(filing.formType) || /更正|修正|amend(?:ment|ed)?/i.test(filing.title ?? '')) return 'CORRECTS';
  if (existing.length === 0) return 'SUPPLEMENTS';
  const nextForm = filing.formType.toLowerCase();
  const isRegulatoryPair = existing.some((item) => {
    const priorForm = item.formType.toLowerCase();
    return (nextForm === '8-k' && /^(10-q|10-k)$/.test(priorForm))
      || (priorForm === '8-k' && /^(10-q|10-k)$/.test(nextForm));
  });
  if (isRegulatoryPair) return 'SUPPLEMENTS';
  const progression = ['preview', 'preliminary', '10-q', '10-k'];
  if (progression.includes(nextForm) || existing.some((item) => progression.includes(item.formType.toLowerCase()))) {
    return 'SUPERSEDES';
  }
  return 'SUPPLEMENTS';
}

export function isUnaudited(formType: string, title: string | null, text: string): boolean {
  return /preview|preliminary/i.test(formType) || /业绩预告|业绩快报|未经审计|unaudited/i.test(`${title ?? ''}\n${text.slice(0, 5000)}`);
}

interface GuidanceCandidateForSourceCheck {
  metricCode: string;
  value: { min: string; max: string };
  unit: string;
  scale: number;
}

export function guidanceSourceSupportsCandidate(
  quote: string,
  candidate: GuidanceCandidateForSourceCheck,
): boolean {
  if (!guidanceQuoteNamesMetric(quote, candidate.metricCode)) return false;
  const numbers = extractGuidanceNumbers(quote);
  const min = new Prisma.Decimal(candidate.value.min);
  const max = new Prisma.Decimal(candidate.value.max);
  if (numbers.some((value) => value.eq(min)) && numbers.some((value) => value.eq(max))) return true;

  const midpoint = min.add(max).div(2);
  if (!numbers.some((value) => value.eq(midpoint))) return false;
  const spreadPercentage = max.sub(min).div(midpoint).div(2).mul(100);
  return numbers.some((value) => value.sub(spreadPercentage).abs().lte('0.05'))
    && /(?:\+\/?[-\s]*|plus\s+or\s+minus|上下浮动|增减|波动)[^\d]{0,12}\d+(?:\.\d+)?\s*%/i.test(quote);
}

export function normalizeManagementClaimCandidate(
  raw: unknown,
): ReturnType<typeof EarningsManagementClaimCandidateSchema.safeParse> {
  const parsed = EarningsManagementClaimCandidateSchema.safeParse(raw);
  if (parsed.success) return parsed;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return parsed;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.sourceQuote !== 'string' || candidate.sourceQuote.trim() === '') return parsed;
  return EarningsManagementClaimCandidateSchema.safeParse({ ...candidate, text: candidate.sourceQuote });
}

function guidanceQuoteNamesMetric(quote: string, metricCode: string): boolean {
  const patterns: Record<string, RegExp[]> = {
    revenue: [/\brevenue\b/i, /\bsales\b/i, /营业收入|营业总收入/],
    operatingIncome: [/operating (?:income|profit)/i, /营业利润/],
    netIncome: [/\bnet income\b|\bnet profit\b/i, /净利润/],
    netIncomeAttrib: [/net income attributable/i, /归母净利润|归属于.*股东.*净利润/],
    epsBasic: [/basic earnings per share|basic eps/i, /基本每股收益/],
    epsDiluted: [/diluted earnings per share|diluted eps/i, /稀释每股收益/],
    grossProfit: [/gross profit/i, /毛利润/],
    grossMargin: [/gross margin/i, /毛利率/],
    operatingCashFlow: [/cash .*operating activities|operating cash flow/i, /经营活动.*现金流量净额/],
    capitalExpenditures: [/capital expenditure|property.*equipment/i, /资本开支|购建固定资产/],
    freeCashFlow: [/free cash flow/i, /自由现金流/],
  };
  return (patterns[metricCode] ?? []).some((pattern) => pattern.test(quote));
}

function extractGuidanceNumbers(quote: string): Prisma.Decimal[] {
  const matches = quote.match(/\(?[-+]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/g) ?? [];
  return matches.flatMap((raw) => {
    const negative = raw.startsWith('(') && raw.endsWith(')');
    try {
      const value = new Prisma.Decimal(raw.replace(/[(),\s]/g, ''));
      return [negative ? value.negated() : value];
    } catch {
      return [];
    }
  });
}
