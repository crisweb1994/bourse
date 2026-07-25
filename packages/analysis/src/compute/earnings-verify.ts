import Decimal from 'decimal.js';
import {
  MetricFactCandidateSchema,
  MetricFactSchema,
  type MetricFact,
  type MetricFactCandidate,
  type MetricValue,
} from '../contracts/earnings';
import { computeContentHash } from '../util/content-hash';

const INSTANT_METRICS = new Set<MetricFact['metricCode']>([
  'totalAssets',
  'totalLiabilities',
  'totalEquity',
  'cashAndCashEquivalents',
]);

const US_QUARTERLY_CORE_METRICS = new Set<MetricFact['metricCode']>([
  'revenue',
  'operatingIncome',
  'netIncome',
  'epsBasic',
  'epsDiluted',
]);

export interface EarningsDerivationText {
  id: string;
  filingId: string;
  contentHash: string;
  text: string;
  pages?: Array<{
    page: number;
    startOffset: number;
    endOffset: number;
  }>;
}

export interface EarningsEventIdentity {
  periodEndOn: string;
  periodType?: 'Q1' | 'Q2' | 'Q3' | 'H1' | 'FY';
  reportingScope: 'consolidated' | 'parent' | 'unknown';
}

export interface RejectedMetricCandidate {
  candidate: MetricFactCandidate | null;
  rawCandidate?: unknown;
  reasons: string[];
}

export interface VerifyEarningsCandidatesResult {
  facts: MetricFact[];
  rejected: RejectedMetricCandidate[];
}

export interface VerifyEarningsCandidatesInput {
  candidates: unknown[];
  derivation: EarningsDerivationText;
  event: EarningsEventIdentity;
  priorFacts?: MetricFact[];
  historyByMetric?: Partial<Record<MetricFact['metricCode'], string[]>>;
  yoyTolerancePercentagePoints?: number;
  accountingToleranceRatio?: number;
  outlierMultiple?: number;
}

/**
 * Turns LLM candidates into displayable facts. Passing means the candidate is
 * internally consistent and source-anchored; it is not a correctness proof.
 */
export function verifyEarningsCandidates(
  input: VerifyEarningsCandidatesInput,
): VerifyEarningsCandidatesResult {
  const accepted: MetricFact[] = [];
  const rejected: RejectedMetricCandidate[] = [];
  const sharedPeriodStarts = collectSharedPeriodStarts(input.candidates);

  for (const raw of input.candidates) {
    const sanitized = sanitizeMetricCandidate(
      raw,
      sharedPeriodStarts,
      input.derivation.text,
      input.event,
    );
    const parsed = MetricFactCandidateSchema.safeParse(sanitized.value);
    if (!parsed.success) {
      rejected.push({ candidate: null, rawCandidate: raw, reasons: ['schema_invalid'] });
      continue;
    }
    const candidate = parsed.data;
    const reasons: string[] = [];
    const checks: string[] = [...sanitized.normalizations];
    if (
      input.derivation.pages?.length
      && candidate.sourcePage === undefined
      && !sanitized.normalizations.includes('omit_nonpositive_source_page')
    ) {
      reasons.push('source_page_required_for_paged_filing');
    }

    let anchored = locateSourceSpan(
      input.derivation.text,
      candidate.sourceQuote,
      input.derivation.pages?.length ? candidate.sourcePage : undefined,
      input.derivation.pages,
    );
    if (
      !anchored
      && candidate.sourcePage !== undefined
      && input.derivation.pages?.length
    ) {
      anchored = locateSourceSpan(
        input.derivation.text,
        candidate.sourceQuote,
        undefined,
        input.derivation.pages,
      );
      if (anchored) checks.push('source_page_corrected_by_unique_quote');
    }
    if (!anchored) {
      reasons.push('source_quote_not_uniquely_located');
    } else {
      checks.push('source_anchor');
      if (!quoteNamesMetric(anchored.quote, candidate.metricCode, candidate.unit)) {
        reasons.push('source_metric_mismatch');
      } else {
        checks.push('source_metric');
      }
      if (!quoteContainsValue(anchored.quote, candidate.value, candidate.metricCode)) {
        reasons.push('source_value_mismatch');
      } else {
        checks.push('source_value');
      }
    }

    if (candidate.periodEndOn !== input.event.periodEndOn) {
      reasons.push('period_end_mismatch');
    } else {
      checks.push('period');
    }

    if (
      input.event.reportingScope !== 'unknown' &&
      candidate.consolidationScope !== input.event.reportingScope
    ) {
      reasons.push('consolidation_scope_mismatch');
    } else {
      checks.push('reporting_scope');
    }

    if (candidate.periodKind === 'instant' && candidate.accumulation !== 'discrete') {
      reasons.push('instant_metric_must_be_discrete');
    }
    if (candidate.unit !== 'currency' && candidate.scale !== 1) {
      reasons.push('scaled_non_currency_metric');
    } else {
      checks.push('unit_scale');
    }

    const normalizedValue = normalizeMetricValue(candidate.value, candidate.scale);

    const prior = input.priorFacts?.find(
      (fact) =>
        fact.metricCode === candidate.metricCode &&
        fact.unit === candidate.unit &&
        fact.currency === candidate.currency &&
        fact.periodKind === candidate.periodKind &&
        fact.accumulation === candidate.accumulation &&
        fact.accountingBasis === candidate.accountingBasis &&
        fact.consolidationScope === candidate.consolidationScope,
    );
    if (candidate.claimedYoYPct && prior) {
      const yoy = calculatePercentChange(normalizedValue, prior.normalizedValue ?? prior.value);
      if (yoy !== null) {
        const tolerance = input.yoyTolerancePercentagePoints ?? 0.2;
        if (new Decimal(yoy).sub(candidate.claimedYoYPct).abs().gt(tolerance)) {
          reasons.push('claimed_yoy_mismatch');
        } else {
          checks.push('claimed_yoy');
        }
      }
    }

    const history = input.historyByMetric?.[candidate.metricCode] ?? [];
    if (isGrossOutlier(normalizedValue, history, input.outlierMultiple ?? 50)) {
      reasons.push('historical_outlier');
    } else if (history.length >= 3) {
      checks.push('historical_range');
    }

    if (reasons.length > 0 || !anchored) {
      rejected.push({ candidate, reasons });
      continue;
    }

    const factId = computeContentHash({
      text: JSON.stringify({
        metricCode: candidate.metricCode,
        normalizedValue,
        periodEndOn: candidate.periodEndOn,
        scope: candidate.consolidationScope,
        startOffset: anchored.startOffset,
      }),
    });

    accepted.push(
      MetricFactSchema.parse({
        id: factId,
        metricCode: candidate.metricCode,
        value: candidate.value,
        normalizedValue,
        unit: candidate.unit,
        currency: candidate.currency,
        scale: candidate.scale,
        periodStartOn: candidate.periodStartOn,
        periodEndOn: candidate.periodEndOn,
        periodKind: candidate.periodKind,
        accumulation: candidate.accumulation,
        accountingBasis: candidate.accountingBasis,
        consolidationScope: candidate.consolidationScope,
        derivation: { kind: 'reported' },
        provenance: {
          kind: 'filingSpan',
          filingId: input.derivation.filingId,
          derivationId: input.derivation.id,
          contentHash: input.derivation.contentHash,
          quote: anchored.quote,
          startOffset: anchored.startOffset,
          endOffset: anchored.endOffset,
          page: anchored.page,
          section: candidate.sourceSection,
        },
        claimedYoYPct: candidate.claimedYoYPct,
        comparisons: [],
        checkStatus: { status: 'passed', checks },
        reconcileStatus: { status: 'pending' },
      }),
    );
  }

  deduplicateFacts(accepted, rejected);
  applyAccountingIdentityGate(
    accepted,
    rejected,
    input.accountingToleranceRatio ?? 0.005,
  );
  return { facts: accepted, rejected };
}

function sanitizeMetricCandidate(
  raw: unknown,
  sharedPeriodStarts: ReadonlyMap<string, string> = new Map(),
  sourceText = '',
  event?: EarningsEventIdentity,
): { value: unknown; normalizations: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: raw, normalizations: [] };
  }
  const candidate = { ...(raw as Record<string, unknown>) };
  const normalizations: string[] = [];
  for (const key of ['currency', 'periodStartOn', 'claimedYoYPct', 'sourcePage', 'sourceSection']) {
    if (candidate[key] === null) {
      delete candidate[key];
      normalizations.push(`omit_null_${key}`);
    }
  }
  if (candidate.value && typeof candidate.value === 'object' && !Array.isArray(candidate.value)) {
    const value = { ...(candidate.value as Record<string, unknown>) };
    if (value.kind === 'scalar' && value.value === undefined && typeof value.amount === 'string') {
      value.value = value.amount;
      delete value.amount;
      normalizations.push('scalar_amount_to_value');
    }
    if (
      value.kind === 'scalar'
      && typeof value.value === 'string'
      && typeof candidate.sourceQuote === 'string'
      && isRangeForecastDisclosure(sourceText, candidate.sourceQuote)
    ) {
      const quotedRange = inferQuotedRange(candidate.sourceQuote, value.value);
      if (quotedRange) {
        candidate.value = quotedRange;
        normalizations.push('quoted_range_from_scalar');
      } else {
        candidate.value = value;
      }
    } else {
      candidate.value = value;
    }
  }
  if (typeof candidate.sourcePage === 'string' && /^\d+$/.test(candidate.sourcePage)) {
    candidate.sourcePage = Number(candidate.sourcePage);
    normalizations.push('source_page_string_to_integer');
  }
  if (typeof candidate.sourcePage === 'number' && candidate.sourcePage <= 0) {
    delete candidate.sourcePage;
    normalizations.push('omit_nonpositive_source_page');
  }
  if (typeof candidate.scale === 'string' && /^\d+$/.test(candidate.scale)) {
    candidate.scale = Number(candidate.scale);
    normalizations.push('scale_string_to_integer');
  }
  if (typeof candidate.claimedYoYPct === 'number' && Number.isFinite(candidate.claimedYoYPct)) {
    candidate.claimedYoYPct = String(candidate.claimedYoYPct);
    normalizations.push('claimed_yoy_number_to_decimal');
  }
  if (typeof candidate.claimedYoYPct === 'string') {
    const percentage = candidate.claimedYoYPct.trim().match(/^([-+]?(?:\d+(?:\.\d+)?|\.\d+))\s*%$/);
    if (percentage) {
      candidate.claimedYoYPct = percentage[1];
      normalizations.push('claimed_yoy_percent_to_decimal');
    } else if (/\b(?:pts?|percentage\s+points?)\b/i.test(candidate.claimedYoYPct)) {
      // A margin change in percentage points is not a year-over-year percent
      // change. Omitting the optional claim preserves the reported fact while
      // preventing the value from entering the YoY consistency check.
      delete candidate.claimedYoYPct;
      normalizations.push('omit_percentage_point_as_claimed_yoy');
    }
  }
  if (typeof candidate.metricCode === 'string') {
    const expectedKind = INSTANT_METRICS.has(candidate.metricCode as MetricFact['metricCode'])
      ? 'instant'
      : 'duration';
    if (candidate.periodKind !== expectedKind) {
      candidate.periodKind = expectedKind;
      normalizations.push('metric_period_kind');
      if (expectedKind === 'instant') {
        delete candidate.periodStartOn;
        candidate.accumulation = 'discrete';
      }
    }
  }
  if (
    candidate.accountingBasis === 'CAS'
    && candidate.periodKind === 'duration'
    && typeof candidate.periodEndOn === 'string'
    && /^\d{4}-03-31$/.test(candidate.periodEndOn)
  ) {
    const year = candidate.periodEndOn.slice(0, 4);
    if (candidate.periodStartOn === undefined) {
      candidate.periodStartOn = `${year}-01-01`;
      normalizations.push('cas_q1_period_start');
    }
    if (candidate.accumulation === 'discrete') {
      candidate.accumulation = 'YTD';
      normalizations.push('cas_q1_accumulation');
    }
  }
  if (
    candidate.accountingBasis === 'GAAP'
    && candidate.periodKind === 'duration'
    && typeof candidate.metricCode === 'string'
    && US_QUARTERLY_CORE_METRICS.has(candidate.metricCode as MetricFact['metricCode'])
    && event?.periodType
    && ['Q1', 'Q2', 'Q3'].includes(event.periodType)
    && candidate.periodEndOn === event.periodEndOn
  ) {
    const quarterStart = inferQuarterStartFromDocument(sourceText, event.periodEndOn);
    if (quarterStart && candidate.periodStartOn !== quarterStart) {
      candidate.periodStartOn = quarterStart;
      normalizations.push('gaap_quarter_period_start');
    }
    if (quarterStart && candidate.accumulation !== 'discrete') {
      candidate.accumulation = 'discrete';
      normalizations.push('gaap_quarter_accumulation');
    }
  }
  if (
    candidate.periodKind === 'duration'
    && candidate.periodStartOn === undefined
  ) {
    const sharedStart = sharedPeriodStarts.get(periodStartIdentity(candidate));
    if (sharedStart) {
      candidate.periodStartOn = sharedStart;
      normalizations.push('shared_period_start');
    }
  }
  if (
    candidate.periodKind === 'duration'
    && candidate.accumulation === 'discrete'
    && candidate.periodStartOn === undefined
    && typeof candidate.periodEndOn === 'string'
  ) {
    const inferredStart = inferQuarterStartFromDocument(sourceText, candidate.periodEndOn);
    if (inferredStart) {
      candidate.periodStartOn = inferredStart;
      normalizations.push('period_start_from_prior_period_end');
    }
  }
  return { value: candidate, normalizations };
}

function isRangeForecastDisclosure(sourceText: string, quote: string): boolean {
  return /业绩预告|业绩预测/.test(sourceText.slice(0, 2_000))
    || /(?:预计|预期|预测|盈利)[^。\n]{0,40}(?:区间|范围|为|：|:)/.test(quote);
}

function collectSharedPeriodStarts(candidates: unknown[]): Map<string, string> {
  const byIdentity = new Map<string, Map<string, number>>();
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    if (
      candidate.periodKind !== 'duration'
      || typeof candidate.periodStartOn !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.periodStartOn)
    ) continue;
    const key = periodStartIdentity(candidate);
    const counts = byIdentity.get(key) ?? new Map<string, number>();
    counts.set(candidate.periodStartOn, (counts.get(candidate.periodStartOn) ?? 0) + 1);
    byIdentity.set(key, counts);
  }
  const shared = new Map<string, string>();
  for (const [key, counts] of byIdentity) {
    if (counts.size !== 1) continue;
    const [start, count] = [...counts.entries()][0] ?? [];
    if (start && count !== undefined && count >= 2) shared.set(key, start);
  }
  return shared;
}

function periodStartIdentity(candidate: Record<string, unknown>): string {
  return JSON.stringify([
    candidate.periodEndOn,
    candidate.accumulation,
    candidate.accountingBasis,
    candidate.consolidationScope,
  ]);
}

function inferQuarterStartFromDocument(text: string, periodEndOn: string): string | null {
  const end = parseIsoDate(periodEndOn);
  if (!end) return null;
  const dates = new Map<string, Date>();
  const add = (year: string, month: string, day: string) => {
    const parsed = parseIsoDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    if (parsed) dates.set(parsed.toISOString().slice(0, 10), parsed);
  };
  for (const match of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    add(match[1], match[2], match[3]);
  }
  for (const match of text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    add(match[1], match[2], match[3]);
  }
  const months: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const monthPattern = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const splitTableHeader = new RegExp(
    `\\b(${monthPattern})\\s+(\\d{1,2}),\\s*(${monthPattern})\\s+(\\d{1,2}),\\s*(\\d{4})(\\d{4})\\b`,
    'gi',
  );
  for (const match of text.matchAll(splitTableHeader)) {
    add(match[5], String(months[match[1].toLowerCase()]), match[2]);
    add(match[6], String(months[match[3].toLowerCase()]), match[4]);
  }
  for (const match of text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/gi)) {
    add(match[3], String(months[match[1].toLowerCase()]), match[2]);
  }

  const dayMs = 86_400_000;
  const candidates = [...dates.values()]
    .map((date) => ({ date, daysBefore: (end.getTime() - date.getTime()) / dayMs }))
    .filter(({ daysBefore }) => daysBefore >= 80 && daysBefore <= 100)
    .sort((a, b) => Math.abs(a.daysBefore - 91) - Math.abs(b.daysBefore - 91));
  if (candidates.length === 0) return inferStartFromThreeMonthHeader(text, end);
  const inclusiveStart = candidates.find(({ daysBefore }) => daysBefore === 90);
  if (inclusiveStart) return inclusiveStart.date.toISOString().slice(0, 10);
  if (
    candidates.length > 1
    && Math.abs(candidates[0].daysBefore - 91) === Math.abs(candidates[1].daysBefore - 91)
  ) return null;
  return new Date(candidates[0].date.getTime() + dayMs).toISOString().slice(0, 10);
}

function inferStartFromThreeMonthHeader(text: string, end: Date): string | null {
  if (!/\bthree\s+months\s+ended(?=\s|six\b|$)/i.test(text)) return null;
  const endMonth = end.getUTCMonth();
  const endDay = end.getUTCDate();
  const lastDayOfMonth = new Date(Date.UTC(end.getUTCFullYear(), endMonth + 1, 0)).getUTCDate();
  if (endDay === lastDayOfMonth && [2, 5, 8, 11].includes(endMonth)) {
    return new Date(Date.UTC(end.getUTCFullYear(), endMonth - 2, 1)).toISOString().slice(0, 10);
  }
  const targetMonthStart = new Date(Date.UTC(end.getUTCFullYear(), endMonth - 3, 1));
  const targetLastDay = new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  return new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth(),
    Math.min(endDay, targetLastDay),
  )).toISOString().slice(0, 10);
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function normalizeMetricValue(value: MetricValue, scale: number): MetricValue {
  if (value.kind === 'scalar') {
    return { kind: 'scalar', value: new Decimal(value.value).mul(scale).toString() };
  }
  return {
    kind: 'range',
    min: new Decimal(value.min).mul(scale).toString(),
    max: new Decimal(value.max).mul(scale).toString(),
  };
}

export function calculatePercentChange(
  current: MetricValue,
  prior: MetricValue,
): string | null {
  if (current.kind !== 'scalar' || prior.kind !== 'scalar') return null;
  const previous = new Decimal(prior.value);
  if (previous.lte(0)) return null;
  return new Decimal(current.value)
    .sub(previous)
    .div(previous)
    .mul(100)
    .toDecimalPlaces(6)
    .toString();
}

interface LocatedSpan {
  quote: string;
  startOffset: number;
  endOffset: number;
  page?: number;
}

export function locateSourceSpan(
  text: string,
  quote: string,
  pageHint?: number,
  pages?: EarningsDerivationText['pages'],
): LocatedSpan | null {
  const normalizedText = normalizeWithOffsetMap(text);
  const normalizedQuote = normalizeText(quote);
  if (!normalizedQuote) return null;

  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= normalizedText.value.length - normalizedQuote.length) {
    const index = normalizedText.value.indexOf(normalizedQuote, cursor);
    if (index < 0) break;
    matches.push(index);
    cursor = index + 1;
  }

  const candidates: Array<{ startOffset: number; endOffset: number; page?: number }> = [];
  for (const start of matches) {
    const endIndex = start + normalizedQuote.length - 1;
    const startOffset = normalizedText.offsets[start];
    const lastOffset = normalizedText.offsets[endIndex];
    if (startOffset === undefined || lastOffset === undefined) continue;
    const page = pages?.find(
      (entry) => startOffset >= entry.startOffset && startOffset < entry.endOffset,
    )?.page;
    if (pageHint !== undefined && page !== pageHint) continue;
    candidates.push({
      startOffset,
      endOffset: lastOffset + 1,
      ...(page ? { page } : {}),
    });
  }

  if (candidates.length !== 1) return null;
  const match = candidates[0];
  return {
    quote: text.slice(match.startOffset, match.endOffset),
    startOffset: match.startOffset,
    endOffset: match.endOffset,
    ...(match.page ? { page: match.page } : {}),
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

const METRIC_QUOTE_PATTERNS: Record<MetricFact['metricCode'], RegExp[]> = {
  revenue: [/\brevenues?(?=\s|\$|:|\d|$)/i, /\bnet sales/i, /营业\s*(?:总\s*)?收入/],
  costOfRevenue: [/cost of (?:revenue|sales)/i, /营业\s*(?:总\s*)?成本/],
  grossProfit: [/gross profit/i, /毛利(?:润)?/],
  operatingIncome: [/operating\s+(?:income|profit)/i, /income from operations/i, /营业利润/],
  netIncome: [/\bnet income\b/i, /\bnet profit\b/i, /净利\s*润/],
  netIncomeAttrib: [
    /net income attributable to/i,
    /net income (?:available|attributable) to common/i,
    /归属于[：:\s]*(?:上市公司|母公司|本行)?\s*股东的?\s*净\s*利\s*润/,
    /归母净利润/,
  ],
  epsBasic: [/basic (?:earnings|income).{0,20}per share/i, /basic eps/i, /^basic\b/i, /基本\s*每股收益/],
  epsDiluted: [
    /diluted (?:earnings|income).{0,20}per share/i,
    /net income per diluted share/i,
    /earnings per common share\s*-\s*diluted/i,
    /earnings?(?:\s*\(loss\))?\s+per share.{0,40}diluted/i,
    /diluted eps/i,
    /^diluted\b/i,
    /稀释\s*每股收益/,
  ],
  grossMargin: [/gross margin/i, /毛利率/],
  operatingMargin: [/operating margin/i, /营业利润率/],
  netMargin: [/net margin/i, /净利率/],
  operatingCashFlow: [
    /(?:net )?cash (?:flows? )?(?:provided by|from|generated by) operating activities/i,
    /operating cash flow/i,
    /cash flows? from operations/i,
    /经营活动产生的现金流量\s*净\s*额/,
  ],
  capitalExpenditures: [
    /capital expenditures?/i,
    /purchases? of (?:property|properties).{0,30}(?:equipment|technology)/i,
    /payments? for acquisition of property.{0,30}equipment/i,
    /购建固定资产.{0,20}支付的现金/,
    /资本开支/,
  ],
  freeCashFlow: [/free cash flow/i, /自由现金流/],
  totalAssets: [/total assets/i, /资产\s*(?:总计|合计)/, /总\s*资产/, /资产\s*总额/],
  totalLiabilities: [/total liabilities/i, /负债(?:合计|总额)/],
  totalEquity: [/(?:total )?(?:stockholders'|shareholders'|owners') equity/i, /\btotal equity\b/i, /所有者权益.{0,10}合计/, /股东权益.{0,10}合计/],
  cashAndCashEquivalents: [/cash and cash equivalents/i, /现金及现金等价物/],
};

function quoteNamesMetric(
  quote: string,
  metricCode: MetricFact['metricCode'],
  unit: MetricFactCandidate['unit'],
): boolean {
  if (metricCode === 'grossProfit' && unit === 'currency' && /gross margin/i.test(quote)) {
    return true;
  }
  if (
    metricCode === 'netIncome'
    && /net income (?:available|attributable) to common|net income attributable to|归属于[：:\s]*(?:上市公司|母公司|本行)?\s*股东的?\s*净\s*利\s*润|归母净\s*利\s*润/i.test(quote)
  ) {
    return false;
  }
  return METRIC_QUOTE_PATTERNS[metricCode].some((pattern) => pattern.test(quote));
}

function quoteContainsValue(
  quote: string,
  value: MetricValue,
  metricCode: MetricFact['metricCode'],
): boolean {
  if (value.kind === 'range') {
    const quotedRange = inferQuotedRange(quote, value.min) ?? inferQuotedRange(quote, value.max);
    if (
      quotedRange?.kind === 'range'
      && new Decimal(quotedRange.min).eq(value.min)
      && new Decimal(quotedRange.max).eq(value.max)
    ) return true;
  }
  const observed = extractDecimalTokens(quote);
  const expected = value.kind === 'scalar' ? [value.value] : [value.min, value.max];
  return expected.every((raw) => {
    const target = new Decimal(raw);
    return observed.some((candidate) => (
      candidate.eq(target)
      || (metricCode === 'capitalExpenditures' && candidate.abs().eq(target.abs()))
    ));
  });
}

function extractDecimalTokens(quote: string): Decimal[] {
  const matches = quote.match(/\(?[-+]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/g) ?? [];
  return matches.flatMap((raw) => {
    const wrappedNegative = raw.startsWith('(') && raw.endsWith(')');
    const normalized = raw.replace(/[(),\s]/g, '');
    try {
      const decimal = new Decimal(normalized);
      return [wrappedNegative ? decimal.negated() : decimal];
    } catch {
      return [];
    }
  });
}

function inferQuotedRange(quote: string, scalar: string): MetricValue | null {
  let target: Decimal;
  try {
    target = new Decimal(scalar);
  } catch {
    return null;
  }

  const number = String.raw`\(?[-+]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?`;
  const pattern = new RegExp(
    String.raw`(${number})[^\d]{0,24}?(?:-|–|—|~|～|至|到)\s*(${number})`,
    'g',
  );
  for (const match of quote.matchAll(pattern)) {
    const left = parseQuotedDecimal(match[1]);
    const right = parseQuotedDecimal(match[2]);
    if (!left || !right || (!left.eq(target) && !right.eq(target))) continue;
    return left.lte(right)
      ? { kind: 'range', min: left.toString(), max: right.toString() }
      : { kind: 'range', min: right.toString(), max: left.toString() };
  }
  return null;
}

function parseQuotedDecimal(raw: string | undefined): Decimal | null {
  if (!raw) return null;
  const wrappedNegative = raw.trim().startsWith('(') && raw.trim().endsWith(')');
  const normalized = raw.replace(/[(),\s]/g, '');
  try {
    const value = new Decimal(normalized);
    return wrappedNegative ? value.negated() : value;
  } catch {
    return null;
  }
}

function deduplicateFacts(
  accepted: MetricFact[],
  rejected: RejectedMetricCandidate[],
): void {
  const groups = new Map<string, MetricFact[]>();
  for (const fact of accepted) {
    const key = factSemanticIdentity(fact);
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const values = new Set(group.map((fact) => JSON.stringify(fact.normalizedValue ?? fact.value)));
    const remove = values.size === 1 ? group.slice(1) : group;
    const reason = values.size === 1 ? 'duplicate_metric_candidate' : 'duplicate_metric_conflict';
    for (const fact of remove) {
      const index = accepted.indexOf(fact);
      if (index >= 0) accepted.splice(index, 1);
      rejected.push({ candidate: candidateFromFact(fact), reasons: [reason] });
    }
  }
}

function factSemanticIdentity(fact: MetricFact): string {
  return JSON.stringify([
    fact.metricCode,
    fact.unit,
    fact.currency,
    fact.periodStartOn,
    fact.periodEndOn,
    fact.periodKind,
    fact.accumulation,
    fact.accountingBasis,
    fact.consolidationScope,
  ]);
}

function normalizeWithOffsetMap(value: string): { value: string; offsets: number[] } {
  let normalized = '';
  const offsets: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (/\s/.test(char)) {
      if (normalized.length > 0 && !inWhitespace) {
        normalized += ' ';
        offsets.push(i);
      }
      inWhitespace = true;
      continue;
    }
    normalized += char.toLowerCase();
    offsets.push(i);
    inWhitespace = false;
  }
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    offsets.pop();
  }
  return { value: normalized, offsets };
}

function isGrossOutlier(value: MetricValue, history: string[], multiple: number): boolean {
  if (value.kind !== 'scalar' || history.length < 3) return false;
  const positives = history.map((item) => new Decimal(item).abs()).filter((item) => item.gt(0));
  if (positives.length < 3) return false;
  const sorted = positives.sort((a, b) => a.comparedTo(b));
  const median = sorted[Math.floor(sorted.length / 2)];
  const current = new Decimal(value.value).abs();
  return current.gt(median.mul(multiple)) || (current.gt(0) && current.lt(median.div(multiple)));
}

function applyAccountingIdentityGate(
  accepted: MetricFact[],
  rejected: RejectedMetricCandidate[],
  toleranceRatio: number,
): void {
  const byCode = new Map(accepted.map((fact) => [fact.metricCode, fact]));
  const revenue = byCode.get('revenue');
  const cost = byCode.get('costOfRevenue');
  const gross = byCode.get('grossProfit');
  if (!revenue || !cost || !gross) return;
  if (!sameAccountingIdentity(revenue, cost) || !sameAccountingIdentity(revenue, gross)) return;

  const revenueValue = scalarDecimal(revenue.normalizedValue ?? revenue.value);
  const costValue = scalarDecimal(cost.normalizedValue ?? cost.value);
  const grossValue = scalarDecimal(gross.normalizedValue ?? gross.value);
  if (!revenueValue || !costValue || !grossValue) return;

  const expected = revenueValue.sub(costValue);
  const tolerance = Decimal.max(revenueValue.abs().mul(toleranceRatio), 1);
  if (expected.sub(grossValue).abs().lte(tolerance)) {
    for (const fact of [revenue, cost, gross]) {
      if (fact.checkStatus.status === 'passed') fact.checkStatus.checks.push('gross_profit_identity');
    }
    return;
  }

  for (const fact of [revenue, cost, gross]) {
    const index = accepted.indexOf(fact);
    if (index >= 0) accepted.splice(index, 1);
    rejected.push({
      candidate: candidateFromFact(fact),
      reasons: ['gross_profit_identity_mismatch'],
    });
  }
}

function sameAccountingIdentity(a: MetricFact, b: MetricFact): boolean {
  return (
    a.periodStartOn === b.periodStartOn &&
    a.periodEndOn === b.periodEndOn &&
    a.accumulation === b.accumulation &&
    a.accountingBasis === b.accountingBasis &&
    a.consolidationScope === b.consolidationScope &&
    a.currency === b.currency
  );
}

function scalarDecimal(value: MetricValue): Decimal | null {
  return value.kind === 'scalar' ? new Decimal(value.value) : null;
}

function candidateFromFact(fact: MetricFact): MetricFactCandidate {
  if (fact.provenance.kind !== 'filingSpan') {
    throw new Error('accounting identity gate only accepts filing facts');
  }
  return MetricFactCandidateSchema.parse({
    metricCode: fact.metricCode,
    value: fact.value,
    unit: fact.unit,
    currency: fact.currency,
    scale: fact.scale,
    periodStartOn: fact.periodStartOn,
    periodEndOn: fact.periodEndOn,
    periodKind: fact.periodKind,
    accumulation: fact.accumulation,
    accountingBasis: fact.accountingBasis,
    consolidationScope: fact.consolidationScope,
    claimedYoYPct: fact.claimedYoYPct,
    sourceQuote: fact.provenance.quote,
    sourcePage: fact.provenance.page,
    sourceSection: fact.provenance.section,
  });
}
