import type { StructuredJson } from '../contracts/analysis-result';
import type {
  FactObservation,
  ValidatedFactKey,
} from '../contracts/cross-dim-validator';
import type { SectionType } from '../contracts/enums';

/**
 * RFC-03 §6: cross-dim fact extractors.
 *
 * Each extractor takes a dim's run result (sectionType + structuredJson +
 * reportMarkdown) and tries to recover the dim's value for a given fact.
 * Returns null when the dim didn't surface a usable value — that's not a
 * conflict, just a missing observation; the validator simply has fewer
 * data points to compare.
 *
 * Strategy order per fact:
 *   1. Structured fields (priceTarget.currency, dataAsOf, etc.) — most
 *      reliable, schema-validated.
 *   2. Markdown regex — fallback for facts the LLM only emits as prose
 *      (PE, marketCap). Multi-pattern try-then-skip; first hit wins.
 *
 * Numeric normalization: marketCap is always returned in 亿元 (yi yuan,
 * 100 million units of base currency). PE is unitless. Price is the
 * exact base-currency value (CNY for CN dims).
 */

export interface ExtractInput {
  type: SectionType;
  reportMarkdown: string;
  structuredJson: StructuredJson;
}

// ===== Public API =====

/**
 * Dispatch to the right per-fact extractor. Centralized so the validator
 * loop stays a one-liner: `extractFact(section, factKey)`.
 */
export function extractFact(
  input: ExtractInput,
  factKey: ValidatedFactKey,
): FactObservation | null {
  switch (factKey) {
    case 'price':
      return extractPrice(input);
    case 'marketCap':
      return extractMarketCap(input);
    case 'currency':
      return extractCurrency(input);
    case 'pe':
      return extractPe(input);
    case 'dataAsOf':
      return extractDataAsOf(input);
    default:
      return null;
  }
}

/**
 * Compute % deviation between an observed value and a ground truth.
 * Returns:
 *   - 0 when values are equal (or both 0).
 *   - Positive percent (e.g. 4.5 means 4.5%) for numeric mismatch.
 *   - +Infinity when ground truth is 0 but observed is non-zero.
 *   - null when either side isn't a finite number (caller should fall
 *     back to exact-string comparison for currency / dataAsOf).
 */
export function computeDeviation(
  observed: unknown,
  groundTruth: unknown,
): number | null {
  if (typeof observed !== 'number' || typeof groundTruth !== 'number') {
    return null;
  }
  if (!Number.isFinite(observed) || !Number.isFinite(groundTruth)) {
    return null;
  }
  if (groundTruth === 0) {
    return observed === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return Math.abs((observed - groundTruth) / groundTruth) * 100;
}

// ===== Per-fact extractors =====

function extractPrice(input: ExtractInput): FactObservation | null {
  // 1. Structured: priceTarget.base is the dim's target — close enough
  //    to "the dim's view of price" for cross-dim consistency checks.
  const target = input.structuredJson.priceTarget?.base;
  if (typeof target === 'number' && Number.isFinite(target)) {
    return {
      sectionType: input.type,
      value: target,
      extractedFrom: 'structuredJson.priceTarget.base',
    };
  }
  // 2. Markdown: "当前价 / 现价 / 股价 18.20"
  const md = input.reportMarkdown;
  const patterns = [
    /(?:当前价|现价|股价|最新价)[:：]?\s*([\d,]+\.?\d*)/,
    /price\s*[:：=]\s*([\d,]+\.?\d*)/i,
  ];
  for (const re of patterns) {
    const m = md.match(re);
    if (m) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(v) && v > 0) {
        return {
          sectionType: input.type,
          value: v,
          extractedFrom: 'reportMarkdown:regex:price',
        };
      }
    }
  }
  return null;
}

function extractMarketCap(input: ExtractInput): FactObservation | null {
  // Markdown only — no structured field for marketCap in baseline schema.
  // Normalize to 亿元 regardless of source unit.
  const md = input.reportMarkdown;
  const patterns = [
    /(?:总市值|流通市值|市值)[:：约]?\s*([\d,]+\.?\d*)\s*(亿|万亿|万)/,
    /market[\s-]?cap\s*[:：=]?\s*([\d,]+\.?\d*)\s*(亿|万亿|万|B|M)?/i,
  ];
  for (const re of patterns) {
    const m = md.match(re);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ''));
      if (!Number.isFinite(num) || num <= 0) continue;
      const inYi = normalizeToYi(num, m[2]);
      return {
        sectionType: input.type,
        value: inYi,
        extractedFrom: 'reportMarkdown:regex:marketCap',
      };
    }
  }
  return null;
}

function extractCurrency(input: ExtractInput): FactObservation | null {
  const c = input.structuredJson.priceTarget?.currency;
  if (typeof c === 'string' && c.length === 3) {
    return {
      sectionType: input.type,
      value: c.toUpperCase(),
      extractedFrom: 'structuredJson.priceTarget.currency',
    };
  }
  return null;
}

function extractPe(input: ExtractInput): FactObservation | null {
  // PE has no canonical structured field. Try regex against common shapes:
  //   PE: 28.7  /  PE(TTM): 28.7  /  PE（动态）= 28.7
  //   市盈率：28.7  /  市盈率(TTM) 为 28.7 倍
  const md = input.reportMarkdown;
  const patterns = [
    /PE\s*(?:[\(（][^)）]{0,8}[\)）])?\s*[:：=为]+\s*([\d,]+\.?\d*)/i,
    /市盈率\s*(?:[\(（][^)）]{0,8}[\)）])?\s*[:：=为]+\s*([\d,]+\.?\d*)/,
  ];
  for (const re of patterns) {
    const m = md.match(re);
    if (m) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(v) && v > 0) {
        return {
          sectionType: input.type,
          value: v,
          extractedFrom: 'reportMarkdown:regex:pe',
        };
      }
    }
  }
  return null;
}

function extractDataAsOf(input: ExtractInput): FactObservation | null {
  // Baseline field — required by schema, so always present on valid output.
  const d = input.structuredJson.dataAsOf;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return {
      sectionType: input.type,
      value: d,
      extractedFrom: 'structuredJson.dataAsOf',
    };
  }
  return null;
}

// ===== Internal helpers =====

/**
 * Convert a number + Chinese / English unit to 亿元 (100M base currency).
 *   万亿 (trillion)  → × 10000  (1 万亿 = 10000 亿)
 *   亿  (default)    → × 1
 *   万  (10K)        → / 10000  (1 万 = 0.0001 亿)
 *   B   (billion)    → × 10     (1B = 10 亿)
 *   M   (million)    → / 100    (1M = 0.01 亿)
 *   undefined        → treat as 亿 (Chinese-leaning default for CN market)
 */
function normalizeToYi(value: number, unit: string | undefined): number {
  switch (unit) {
    case '万亿':
      return value * 10000;
    case '万':
      return value / 10000;
    case 'B':
      return value * 10;
    case 'M':
      return value / 100;
    case '亿':
    case undefined:
    default:
      return value;
  }
}
