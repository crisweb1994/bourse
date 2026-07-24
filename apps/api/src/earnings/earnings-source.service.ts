import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type FilingDocument,
  type FilingPort,
  type FilingSummary,
} from '@bourse/analysis';
import { type Stock } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CN_FILING_PORT,
  HK_FILING_PORT,
  US_FILING_PORT,
} from '../connectors/connectors.module';
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

@Injectable()
export class EarningsSourceService {
  private readonly logger = new Logger(EarningsSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(US_FILING_PORT) private readonly usFilings: FilingPort,
    @Inject(CN_FILING_PORT) private readonly cnFilings: FilingPort,
    @Inject(HK_FILING_PORT) private readonly hkFilings: FilingPort,
    private readonly filingStore: FilingStoreService,
  ) {}

  async discoverAndIngest(stock: Stock): Promise<PreparedEarningsSource> {
    const instrumentId = `${stock.market}:${stock.symbol}`;
    const port = stock.market === 'US'
      ? this.usFilings
      : stock.market === 'CN'
        ? this.cnFilings
        : stock.market === 'HK'
          ? this.hkFilings
          : null;
    if (!port?.getFiling) throw new EarningsSourceError('UNSUPPORTED_MARKET', false);

    const forms = stock.market === 'US'
      ? ['8-K', '10-Q', '10-K']
      : stock.market === 'HK'
        ? ['profit_warning', 'preliminary', 'quarterly', 'interim', 'annual']
        : ['preview', 'preliminary', 'quarterly', 'semiannual', 'annual'];
    const listed = await port.searchFilings({ instrumentId, forms, limit: stock.market === 'HK' ? 20 : stock.market === 'US' ? 12 : 10 });
    if (listed.data.length === 0) {
      throw new EarningsSourceError('NO_ELIGIBLE_FILING', true, listed.warnings[0]?.message);
    }

    const failures: string[] = [];
    let fallbackSource: StructuredFallbackSource | undefined;
    for (const summary of listed.data) {
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
        result = await port.getFiling({ ...summary });
      } catch (error) {
        failures.push(`${summary.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const document = result.data;
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
        && summary.formType.toUpperCase() === '8-K'
        && document.documentKind !== 'EARNINGS_RELEASE'
      ) {
        failures.push(`${summary.id}: no EX-99.1 earnings exhibit`);
        continue;
      }
      try {
        const stored = await this.filingStore.persist(stock, summary, document);
        if (stock.market === 'HK' && summary.sourceGroupId) {
          await this.persistGroupVariants(stock, port, listed.data, summary.sourceGroupId, summary.sourceDocumentId);
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
    port: FilingPort,
    listed: FilingSummary[],
    sourceGroupId: string,
    primarySourceDocumentId: string,
  ): Promise<void> {
    if (!port.getFiling) return;
    const variants = listed.filter((candidate) =>
      candidate.sourceGroupId === sourceGroupId && candidate.sourceDocumentId !== primarySourceDocumentId,
    );
    await Promise.allSettled(variants.map(async (variant) => {
      const existing = await this.prisma.filing.findUnique({
        where: { provider_sourceDocumentId: { provider: variant.provider, sourceDocumentId: variant.sourceDocumentId } },
        select: { id: true },
      });
      if (existing) return;
      const result = await port.getFiling!({ ...variant });
      if (!result.data.text || !result.data.rawContent || !result.data.contentHash) return;
      await this.filingStore.persist(stock, variant, result.data);
    }));
  }

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
