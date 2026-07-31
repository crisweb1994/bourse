import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ResearchWarning } from '../../contracts/warning';
import type { ProviderFilingPort as FilingPort, FilingSummary } from '../../ports/filings';
import type {
  FinancialsBundle,
  FinancialsInput,
  FinancialsLineItem,
  ProviderFinancialsPort as FinancialsPort,
} from '../../ports/financials';
import type { ConnectorRunContext } from '../types';
import { failure as httpFailure } from '../http';
import { parseInstrumentId } from '../../util/instrument-id';

const PROVIDER = 'hkex-derived-financials';

export interface HkexDerivedFinancialsOptions {
  filings: FilingPort;
  now?: () => Date;
  maxDocuments?: number;
}

/**
 * Conservative structured facts derived from an HKEX annual-results document.
 * Ambiguous documents return empty so the router can fall back to a vendor.
 */
export function createHkexDerivedFinancialsConnector(
  options: HkexDerivedFinancialsOptions,
): FinancialsPort {
  return {
    async fetchFinancials(
      input: FinancialsInput,
      ctx: ConnectorRunContext = {},
    ): Promise<ResearchResult<FinancialsBundle | null>> {
      const retrievedAt = (options.now?.() ?? new Date()).toISOString();
      const parsed = parseInstrumentId(input.instrumentId);
      if (!parsed || parsed.market !== 'HK') {
        return failure(retrievedAt, parsed ? 'UNSUPPORTED_MARKET' : 'INVALID_INSTRUMENT', `HKEX-derived financials require an HK instrument, received ${input.instrumentId}.`);
      }
      if (!options.filings.getFiling) {
        return failure(retrievedAt, 'SOURCE_UNAVAILABLE', 'HKEX filing document retrieval is unavailable.');
      }

      const listed = await options.filings.searchFilings({
        instrumentId: parsed.raw,
        forms: ['preliminary', 'annual'],
        limit: Math.max(2, options.maxDocuments ?? 6),
      }, ctx);
      const candidates = listed.data
        .filter(isAnnualCandidate)
        .sort((left, right) => languageRank(left) - languageRank(right));
      const warnings: ResearchWarning[] = [...listed.warnings];

      for (const summary of candidates.slice(0, options.maxDocuments ?? 6)) {
        const document = await options.filings.getFiling({ ...summary }, ctx);
        warnings.push(...document.warnings);
        const text = document.data.text ?? document.data.markdown;
        if (!text || !summary.periodEndOn) continue;
        const facts = parseAnnualFacts(text);
        if (!facts) continue;
        const year = summary.periodEndOn.slice(0, 4);
        return {
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          data: {
            periods: [{
              fiscalPeriod: `FY${year}`,
              kind: 'FY',
              fiscalYearEnd: summary.periodEndOn,
              filed: summary.filingDate.slice(0, 10),
              income: facts.income,
              balance: facts.balance,
              cashFlow: facts.cashFlow,
            }],
            currency: facts.currency,
            sourceUrl: summary.filingUrl,
            retrievedAt,
            provider: PROVIDER,
            qualityTier: 'A',
          },
          citations: document.citations.length > 0 ? document.citations : listed.citations,
          freshness: [{ provider: PROVIDER, asOf: summary.filingDate, retrievedAt, stale: false }],
          warnings: [
            ...warnings,
            {
              code: 'NORMALIZED_WITH_ASSUMPTION',
              message: 'Structured facts were derived from explicitly labelled HKEX annual-result rows; unrecognised rows were omitted.',
              provider: PROVIDER,
              sourceType: 'FILING',
            },
          ],
        };
      }

      return {
        schemaVersion: RESEARCH_SCHEMA_VERSION,
        data: null,
        citations: listed.citations,
        freshness: listed.freshness,
        warnings,
      };
    },
  };
}

function isAnnualCandidate(filing: FilingSummary): boolean {
  if (!filing.periodEndOn) return false;
  if (filing.formType === 'annual') return true;
  return filing.formType === 'preliminary' && /annual|final|year ended|全年|年度/i.test(filing.title ?? '');
}

function languageRank(filing: FilingSummary): number {
  return filing.language === 'en-HK' ? 0 : filing.language === 'zh-HK' ? 1 : 2;
}

interface ParsedAnnualFacts {
  currency: string;
  income: {
    revenue?: FinancialsLineItem;
    operatingIncome?: FinancialsLineItem;
    netIncome?: FinancialsLineItem;
    eps?: FinancialsLineItem;
  };
  balance: {
    totalAssets?: FinancialsLineItem;
    totalLiabilities?: FinancialsLineItem;
    cashAndCashEquivalents?: FinancialsLineItem;
  };
  cashFlow: {
    operatingCashFlow?: FinancialsLineItem;
  };
}

function parseAnnualFacts(text: string): ParsedAnnualFacts | null {
  const unit = parseUnit(text);
  if (!unit) return null;
  const item = (labels: readonly RegExp[], perShare = false): FinancialsLineItem | undefined => {
    const value = labelledValue(text, labels);
    return value === undefined
      ? undefined
      : { value: value * (perShare ? 1 : unit.scale), unit: perShare ? `${unit.currency}/shares` : unit.currency };
  };
  const income = {
    revenue: item([/^\s*(?:revenue|turnover)\b/i]),
    operatingIncome: item([/^\s*(?:operating profit|profit from operations)\b/i]),
    netIncome: item([/^\s*profit attributable to (?:equity holders|owners|shareholders)/i, /^\s*net profit\b/i]),
    eps: item([/^\s*(?:basic )?earnings per share\b/i], true),
  };
  const balance = {
    totalAssets: item([/^\s*total assets\b/i]),
    totalLiabilities: item([/^\s*total liabilities\b/i]),
    cashAndCashEquivalents: item([/^\s*cash and cash equivalents\b/i]),
  };
  const cashFlow = {
    operatingCashFlow: item([/^\s*net cash (?:generated from|from) operating activities\b/i]),
  };
  const populated = [...Object.values(income), ...Object.values(balance), ...Object.values(cashFlow)].filter(Boolean).length;
  if (populated < 2 || (!income.revenue && !income.netIncome)) return null;
  return { currency: unit.currency, income, balance, cashFlow };
}

function parseUnit(text: string): { currency: string; scale: number } | null {
  const header = text.slice(0, 20_000);
  const currency = /(?:RMB|CNY|人民幣|人民币)/i.test(header)
    ? 'CNY'
    : /(?:US\$|USD)/i.test(header)
      ? 'USD'
      : /(?:HK\$|HKD|港幣)/i.test(header)
        ? 'HKD'
        : null;
  if (!currency) return null;
  if (/(?:billion|十亿)/i.test(header)) return { currency, scale: 1_000_000_000 };
  if (/(?:million|百萬|百万)/i.test(header)) return { currency, scale: 1_000_000 };
  if (/(?:亿元|億)/i.test(header)) return { currency, scale: 100_000_000 };
  if (/(?:['’]000|thousand|千元)/i.test(header)) return { currency, scale: 1_000 };
  return null;
}

function labelledValue(text: string, labels: readonly RegExp[]): number | undefined {
  for (const line of text.split(/\r?\n/)) {
    // HKEX tables commonly prefix rows with `1`, `2.` or `(3)`. Strip that
    // presentation-only index before applying the anchored metric labels.
    const content = line.replace(/^\s*\(?\d{1,3}\)?(?:[.):])?\s+/, '');
    if (!labels.some((label) => label.test(content))) continue;
    const tokens = content.match(/\(?-?\d[\d,]*(?:\.\d+)?\)?/g) ?? [];
    const values = tokens.map(parseNumber).filter((value): value is number => value !== undefined);
    if (values.length === 0) continue;
    const candidate = values.length > 1 && Number.isInteger(values[0]) && Math.abs(values[0]!) <= 100
      ? values[1]
      : values[0];
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function parseNumber(value: string): number | undefined {
  const negative = value.startsWith('(') && value.endsWith(')');
  const parsed = Number(value.replace(/[(),]/g, ''));
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : undefined;
}

function failure(
  retrievedAt: string,
  code: ResearchWarning['code'],
  message: string,
): ResearchResult<FinancialsBundle | null> {
  return httpFailure(PROVIDER, null, { retrievedAt, code, message });
}
