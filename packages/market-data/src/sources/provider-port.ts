import type { ResearchResult } from '../contracts/result';
import type { SourceError } from '../contracts/errors';
import type { SourceResult } from '../contracts/source-result';
import type { ResearchWarning } from '../contracts/warning';
import { ResearchCitation } from '../contracts/research-citation';
import { DataFreshness } from '../contracts/freshness';
import { ResearchWarning as ResearchWarningSchema } from '../contracts/warning';
import {
  CompanyProfileSchema,
  EarningsConsensusBundleSchema,
  PriceHistorySchema,
  QuoteSchema,
  type CompanyProfile,
  type CompanyProfilePort,
  type EarningsConsensusBundle,
  type FinancePort,
  type PriceBar,
  type ProviderCompanyProfilePort,
  type ProviderFinancePort,
  type Quote,
} from '../ports/finance';
import { FinancialsBundleSchema, type FinancialsPort, type ProviderFinancialsPort } from '../ports/financials';
import { FilingDocumentSchema, FilingSummarySchema, type FilingPort, type ProviderFilingPort } from '../ports/filings';
import { MacroSnapshotSchema, type MacroPort, type ProviderMacroPort } from '../ports/macro';
import {
  InstrumentSearchResultsSchema,
  type InstrumentSearchResult,
  type InstrumentSearchPort,
  type ProviderInstrumentSearchPort,
} from '../ports/instrument-search';

/**
 * A source plugin owns this boundary. Provider transports may retain their
 * vendor-facing envelope, while registry/router ports always expose SourceResult.
 */
export function sourceFinancePort(sourceId: string, port: ProviderFinancePort): FinancePort {
  return {
    getQuote: async (input, ctx) => toSourceResult(sourceId, await port.getQuote(input, ctx), usableQuote, validates(QuoteSchema)),
    getQuotes: async (inputs, ctx) => Promise.all(inputs.map(async (input) =>
      toSourceResult(sourceId, await port.getQuote(input, ctx), usableQuote, validates(QuoteSchema)))),
    getHistory: async (input, ctx) => toSourceResult(sourceId, await port.getHistory(input, ctx), usableHistory, validates(PriceHistorySchema)),
    ...(port.getProfile
      ? { getProfile: async (input, ctx) => toSourceResult(sourceId, await port.getProfile!(input, ctx), usableProfile, validates(CompanyProfileSchema)) }
      : {}),
    ...(port.fetchEarningsConsensus
      ? { fetchEarningsConsensus: async (input, ctx) => toSourceResult(sourceId, await port.fetchEarningsConsensus!(input, ctx), usableConsensus, validates(EarningsConsensusBundleSchema)) }
      : {}),
  };
}

export function sourceProfilePort(sourceId: string, port: ProviderCompanyProfilePort): CompanyProfilePort {
  return {
    getProfile: async (input, ctx) => toSourceResult(sourceId, await port.getProfile(input, ctx), usableProfile, validates(CompanyProfileSchema)),
  };
}

export function sourceFinancialsPort(sourceId: string, port: ProviderFinancialsPort): FinancialsPort {
  return {
    fetchFinancials: async (input, ctx) => toSourceResult(sourceId, await port.fetchFinancials(input, ctx), (data) => data !== null && data.periods.length > 0, validates(FinancialsBundleSchema)),
  };
}

export function sourceFilingPort(sourceId: string, port: ProviderFilingPort): FilingPort {
  return {
    searchFilings: async (input, ctx) => toSourceResult(sourceId, await port.searchFilings(input, ctx), (data) => data.length > 0, validates(FilingSummarySchema.array())),
    ...(port.getFiling
      ? { getFiling: async (input, ctx) => toSourceResult(sourceId, await port.getFiling!(input, ctx), (data) => Boolean(data.sourceDocumentId), validates(FilingDocumentSchema)) }
      : {}),
  };
}

export function sourceMacroPort(sourceId: string, port: ProviderMacroPort): MacroPort {
  return {
    fetchMacro: async (input, ctx) => toSourceResult(sourceId, await port.fetchMacro(input, ctx), (data) => data.observations.length > 0, validates(MacroSnapshotSchema)),
  };
}

export function sourceInstrumentSearchPort(
  sourceId: string,
  port: ProviderInstrumentSearchPort,
): InstrumentSearchPort {
  return {
    search: async (query, signal) => {
      const data = await port.search(query, signal);
      if (!InstrumentSearchResultsSchema.safeParse(data).success) {
        return invalidResult(sourceId, 'Instrument search returned data outside the canonical schema.');
      }
      return data.length > 0
        ? { status: 'ok', data, sourceId, citations: [], freshness: [], warnings: [] }
        : { status: 'empty', data: null, sourceId, citations: [], freshness: [], warnings: [] };
    },
  };
}

export function toSourceResult<T>(
  sourceId: string,
  result: ResearchResult<T>,
  usable: (data: T) => boolean,
  validate: (data: NonNullable<T>) => boolean = () => true,
): SourceResult<NonNullable<T>> {
  if (!validMetadata(result)) {
    return invalidResult(sourceId, 'Provider result metadata is outside the canonical schema.');
  }
  if (result.data !== null && result.data !== undefined && !validate(result.data as NonNullable<T>)) {
    return invalidResult(sourceId, 'Provider data is outside the canonical capability schema.', result.warnings);
  }
  if (usable(result.data)) {
    return {
      status: 'ok',
      data: result.data as NonNullable<T>,
      sourceId,
      citations: result.citations,
      freshness: result.freshness,
      warnings: result.warnings,
    };
  }
  const error = sourceError(result.warnings);
  if (!error || isEmpty(result.warnings)) {
    return {
      status: 'empty',
      data: null,
      sourceId,
      citations: result.citations,
      freshness: result.freshness,
      warnings: result.warnings,
    };
  }
  return {
    status: 'failed',
    data: null,
    sourceId,
    citations: result.citations,
    freshness: result.freshness,
    warnings: result.warnings,
    error,
  };
}

function validates<T>(schema: { safeParse(data: unknown): { success: boolean } }): (data: T) => boolean {
  return (data) => schema.safeParse(data).success;
}

function validMetadata(result: Pick<ResearchResult<unknown>, 'citations' | 'freshness' | 'warnings'>): boolean {
  return ResearchCitation.array().safeParse(result.citations).success &&
    DataFreshness.array().safeParse(result.freshness).success &&
    ResearchWarningSchema.array().safeParse(result.warnings).success;
}

function invalidResult<T>(sourceId: string, message: string, warnings: ResearchWarning[] = []): SourceResult<T> {
  return {
    status: 'failed',
    data: null,
    sourceId,
    citations: [],
    freshness: [],
    warnings: [...warnings, { code: 'PARTIAL_DATA', message, provider: sourceId }],
    error: { code: 'VALIDATION_FAILED', message },
  };
}

export function unavailable<T>(sourceId: string, message: string): SourceResult<T> {
  return {
    status: 'failed',
    data: null,
    sourceId,
    citations: [],
    freshness: [],
    warnings: [{ code: 'SOURCE_UNAVAILABLE', message, provider: sourceId }],
    error: { code: 'UNSUPPORTED_CAPABILITY', message },
  };
}

function usableQuote(quote: Quote): boolean {
  return Number.isFinite(quote.price) && quote.price > 0;
}

function usableHistory(history: PriceBar[]): boolean {
  return history.filter((bar) => Number.isFinite(bar.close) && bar.close > 0 && !Number.isNaN(Date.parse(bar.timestamp))).length >= 20;
}

function usableProfile(profile: Parameters<typeof profileHasData>[0]): boolean {
  return profileHasData(profile);
}

function usableConsensus(consensus: EarningsConsensusBundle | null): boolean {
  return consensus !== null && consensus.estimates.length > 0;
}

function profileHasData(profile: { description?: string; sector?: string; industry?: string; website?: string; employees?: number }): boolean {
  return Boolean(profile.description || profile.sector || profile.industry || profile.website || typeof profile.employees === 'number');
}

function isEmpty(warnings: ResearchWarning[]): boolean {
  return warnings.length === 0 || warnings.every((warning) => warning.code === 'PARTIAL_DATA' || warning.code === 'STALE_DATA');
}

function sourceError(warnings: ResearchWarning[]): SourceError | undefined {
  const warning = warnings[0];
  if (!warning) return undefined;
  switch (warning.code) {
    case 'AUTH_REQUIRED': return { code: 'AUTH_REQUIRED', message: warning.message, retryAfterMs: warning.retryAfterMs };
    case 'RATE_LIMITED': return { code: 'RATE_LIMITED', message: warning.message, retryAfterMs: warning.retryAfterMs };
    case 'UNSUPPORTED_MARKET': return { code: 'UNSUPPORTED_MARKET', message: warning.message };
    case 'INVALID_INSTRUMENT': return { code: 'UNSUPPORTED_REQUEST', message: warning.message };
    case 'PARTIAL_DATA': return undefined;
    default: return { code: 'SOURCE_UNAVAILABLE', message: warning.message };
  }
}
