import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type FilingDocument,
  type FilingSummary,
} from '@bourse/analysis';
import type { ResearchMarketDataClient } from '@bourse/market-data';
import { type Stock } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MARKET_DATA_CLIENT } from '../connectors/connectors.module';
import { FilingStoreError, FilingStoreService } from '../filings/filing-store.service';
export { buildParserDerivationKey } from '../filings/filing-store.service';

export interface PreparedEarningsSource {
  kind: 'filing';
  filingId: string;
  derivationId: string;
  provider: string;
  sourceDocumentId: string;
  sourceGroupId?: string;
  formType: string;
  title?: string;
  sourceUrl: string;
  publishedAt: string;
  expectedPeriodEndOn?: string;
  documentKind: NonNullable<FilingDocument['documentKind']>;
  contentHash: string;
  normalizedText: string;
  derivationContentHash: string;
  pages?: FilingDocument['pages'];
  language?: FilingDocument['language'];
}

export interface StructuredFallbackSource {
  kind: 'structuredFallback';
  provider: string;
  sourceDocumentId: string;
  sourceGroupId?: string;
  formType: string;
  title?: string;
  sourceUrl: string;
  publishedAt: string;
  expectedPeriodEndOn?: string;
  language?: FilingDocument['language'];
  reason: 'BODY_UNREADABLE' | 'LLM_DISABLED' | 'PROVIDER_UNAVAILABLE';
}

export type EarningsRunSource = PreparedEarningsSource | StructuredFallbackSource;

export interface EarningsSourceOptions {
  excludedSourceGroupIds?: readonly string[];
}

@Injectable()
export class EarningsSourceService {
  private readonly logger = new Logger(EarningsSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MARKET_DATA_CLIENT) private readonly marketData: ResearchMarketDataClient,
    private readonly filingStore: FilingStoreService,
  ) {}

  async discoverAndIngest(
    stock: Stock,
    options: EarningsSourceOptions = {},
  ): Promise<PreparedEarningsSource> {
    const instrumentId = `${stock.market}:${stock.symbol}`;
    if (stock.market !== 'US' && stock.market !== 'CN' && stock.market !== 'HK') {
      throw new EarningsSourceError('UNSUPPORTED_MARKET', false);
    }

    const forms = stock.market === 'US'
      // Foreign private issuers (for example BABA) report through 20-F/6-K,
      // while domestic issuers use 10-K/10-Q/8-K.
      ? ['8-K', '10-Q', '10-K', '6-K', '20-F']
      : stock.market === 'HK'
        ? ['profit_warning', 'preliminary', 'quarterly', 'interim', 'annual']
        : ['preview', 'preliminary', 'quarterly', 'semiannual', 'annual'];
    const listed = await this.marketData.listFilings({ instrumentId, forms, limit: stock.market === 'HK' ? 20 : stock.market === 'US' ? 100 : 10 });
    if (!listed.data?.length) {
      const warning = listed.warnings[0];
      let message = warning?.message;
      // OTC/ADR（如 MPNGY）不在 SEC company_tickers 表里：不是系统故障，是这类
      // 代码没有 SEC 备案，财报速读无法生成。给用户明确语义 + 港股替代引导。
      if (stock.market === 'US' && warning?.code === 'INVALID_INSTRUMENT') {
        message =
          `${stock.symbol} 不是 SEC 备案的美股代码（OTC/ADR 不在 EDGAR 覆盖范围），` +
          '暂不支持财报速读；若为港股公司，请使用其港股代码（如 03690.HK）';
      }
      throw new EarningsSourceError('NO_ELIGIBLE_FILING', true, message);
    }

    const excludedGroups = new Set(options.excludedSourceGroupIds ?? []);
    const candidates = prioritizeEarningsSources(listed.data, stock.market).filter(
      (summary) => !excludedGroups.has(summary.sourceGroupId ?? summary.sourceDocumentId),
    );
    if (candidates.length === 0) {
      throw new EarningsSourceError('NO_NEW_ELIGIBLE_FILING', true);
    }

    const failures: string[] = [];
    let fallbackSource: StructuredFallbackSource | undefined;
    for (const summary of candidates) {
      const alreadyLinked = await this.prisma.filing.findFirst({
        where: {
          provider: summary.provider,
          OR: [
            { sourceGroupId: summary.sourceGroupId ?? summary.sourceDocumentId },
            { sourceDocumentId: summary.sourceDocumentId },
          ],
          eventLinks: { some: {} },
        },
        select: { id: true },
      });
      if (alreadyLinked) continue;
      fallbackSource ??= fallbackFromSummary(summary);
      let result;
      try {
        result = await this.marketData.getFilingDocument({ ...summary });
      } catch (error) {
        failures.push(`${summary.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const document = result.data;
      if (!document) {
        failures.push(result.warnings[0]?.message ?? `${summary.id}: no document`);
        continue;
      }
      fallbackSource = {
        kind: 'structuredFallback',
        provider: document.provider || summary.provider,
        sourceDocumentId: document.sourceDocumentId || summary.sourceDocumentId,
        sourceGroupId: document.sourceGroupId ?? summary.sourceGroupId,
        formType: summary.formType,
        title: summary.title,
        sourceUrl: document.filingUrl || summary.filingUrl,
        publishedAt: parsePublishedAt(summary.filingDate).toISOString(),
        ...(summary.periodEndOn ? { expectedPeriodEndOn: summary.periodEndOn } : {}),
        reason: 'BODY_UNREADABLE',
      };
      if (!document.text || !document.contentHash || !document.rawContent) {
        failures.push(result.warnings[0]?.message ?? `${summary.id}: no readable body`);
        continue;
      }
      if (
        stock.market === 'US'
        && ['8-K', '6-K'].includes(summary.formType.toUpperCase())
        && document.documentKind !== 'EARNINGS_RELEASE'
      ) {
        failures.push(`${summary.id}: ${summary.formType} is not an earnings release`);
        continue;
      }
      try {
        const stored = await this.filingStore.persist(stock, summary, document);
        if (stock.market === 'HK' && summary.sourceGroupId) {
          await this.persistGroupVariants(stock, listed.data, summary.sourceGroupId, summary.sourceDocumentId);
        }
        this.logger.log(`prepared ${stored.filing.provider}:${stored.filing.sourceDocumentId} for ${stock.market}:${stock.symbol}`);
        return {
          kind: 'filing',
          filingId: stored.filing.id,
          derivationId: stored.derivation.id,
          provider: stored.filing.provider,
          sourceDocumentId: stored.filing.sourceDocumentId,
          sourceGroupId: stored.filing.sourceGroupId ?? undefined,
          formType: stored.filing.formType,
          title: stored.filing.title ?? undefined,
          sourceUrl: stored.filing.sourceUrl,
          publishedAt: stored.filing.publishedAt.toISOString(),
          ...(summary.periodEndOn ? { expectedPeriodEndOn: summary.periodEndOn } : {}),
          documentKind: stored.filing.documentKind,
          contentHash: stored.filing.contentHash,
          normalizedText: stored.normalizedText,
          derivationContentHash: stored.derivation.contentHash,
          pages: stored.pages,
          language: document.language,
        };
      } catch (error) {
        if (error instanceof FilingStoreError) {
          throw new EarningsSourceError(error.code, error.code === 'BODY_UNREADABLE');
        }
        throw error;
      }
    }

    if (failures.length === 0) {
      throw new EarningsSourceError('NO_NEW_ELIGIBLE_FILING', true);
    }
    throw new EarningsSourceError('BODY_UNREADABLE', true, failures.join('; '), fallbackSource);
  }

  private async persistGroupVariants(
    stock: Stock,
    listed: FilingSummary[],
    sourceGroupId: string,
    primarySourceDocumentId: string,
  ): Promise<void> {
    const variants = listed.filter((candidate) =>
      candidate.sourceGroupId === sourceGroupId && candidate.sourceDocumentId !== primarySourceDocumentId,
    );
    await Promise.allSettled(variants.map(async (variant) => {
      const existing = await this.prisma.filing.findUnique({
        where: { provider_sourceDocumentId: { provider: variant.provider, sourceDocumentId: variant.sourceDocumentId } },
        select: { id: true },
      });
      if (existing) return;
      const result = await this.marketData.getFilingDocument({ ...variant });
      if (!result.data?.text || !result.data.rawContent || !result.data.contentHash) return;
      await this.filingStore.persist(stock, variant, result.data);
    }));
  }

}

/**
 * HKEX often publishes a concise results announcement before the full annual
 * report. The announcement preserves financial tables much better after PDF
 * text extraction, so prefer it within the same reporting year. Keep provider
 * ordering unchanged for every other market and comparison.
 */
export function prioritizeEarningsSources(
  summaries: readonly FilingSummary[],
  market: string,
): FilingSummary[] {
  if (market === 'US') {
    // SEC returns foreign issuers' frequent 6-K notices before their annual
    // 20-F. Prefer the complete annual filing so discovery does not download
    // dozens of unrelated 6-K notices before finding a usable source.
    const annual = summaries.filter((summary) => summary.formType.toUpperCase() === '20-F');
    if (annual.length > 0) {
      return [...annual, ...summaries.filter((summary) => summary.formType.toUpperCase() !== '20-F')];
    }
    return [...summaries];
  }
  if (market !== 'HK') return [...summaries];
  const ordered = [...summaries];

  reorderMatchingSlots(
    ordered,
    (summary) => summary.sourceGroupId ?? summary.sourceDocumentId,
    (a, b) => hkLanguageRank(a.language) - hkLanguageRank(b.language),
  );
  reorderMatchingSlots(
    ordered,
    (summary) => {
      const formType = summary.formType.toLowerCase();
      if (formType !== 'preliminary' && formType !== 'annual') return undefined;
      return reportYear(summary);
    },
    (a, b) => hkFormRank(a.formType) - hkFormRank(b.formType),
  );

  return ordered;
}

function reorderMatchingSlots(
  summaries: FilingSummary[],
  keyOf: (summary: FilingSummary) => string | undefined,
  compare: (a: FilingSummary, b: FilingSummary) => number,
): void {
  const positionsByKey = new Map<string, number[]>();
  summaries.forEach((summary, index) => {
    const key = keyOf(summary);
    if (!key) return;
    const positions = positionsByKey.get(key) ?? [];
    positions.push(index);
    positionsByKey.set(key, positions);
  });
  for (const positions of positionsByKey.values()) {
    const reordered = positions.map((index) => summaries[index]).sort(compare);
    positions.forEach((position, index) => {
      summaries[position] = reordered[index];
    });
  }
}

function hkLanguageRank(language: FilingSummary['language']): number {
  if (language === 'en-HK') return 0;
  if (language === 'zh-HK') return 1;
  return 2;
}

function hkFormRank(formType: string): number {
  return formType.toLowerCase() === 'preliminary' ? 0 : 1;
}

function reportYear(summary: FilingSummary): string | undefined {
  const periodYear = summary.periodEndOn?.match(/^(20\d{2})/)?.[1];
  if (periodYear) return periodYear;
  return summary.title?.match(/\b(20\d{2})\b/)?.[1];
}

export class EarningsSourceError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    detail?: string,
    public readonly fallbackSource?: StructuredFallbackSource,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

function parsePublishedAt(value: string): Date {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function fallbackFromSummary(summary: FilingSummary): StructuredFallbackSource {
  return {
    kind: 'structuredFallback',
    provider: summary.provider,
    sourceDocumentId: summary.sourceDocumentId,
    sourceGroupId: summary.sourceGroupId,
    formType: summary.formType,
    title: summary.title,
    sourceUrl: summary.filingUrl,
    publishedAt: parsePublishedAt(summary.filingDate).toISOString(),
    ...(summary.periodEndOn ? { expectedPeriodEndOn: summary.periodEndOn } : {}),
    language: summary.language,
    reason: 'BODY_UNREADABLE',
  };
}
