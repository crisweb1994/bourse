import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  computeContentHash,
  sectionizeFilingText,
  type FilingDocument,
  type FilingPort,
  type FilingSummary,
} from '@bourse/analysis';
import { Prisma, type Stock } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CN_FILING_PORT,
  US_FILING_PORT,
} from '../connectors/connectors.module';

const PARSER_VERSION = 'earnings-text-v2';
const DERIVATION_SCHEMA_VERSION = 'earnings-derivation-v2';

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
  reason: 'BODY_UNREADABLE' | 'LLM_DISABLED' | 'BUDGET_EXHAUSTED' | 'PROVIDER_UNAVAILABLE';
}

export type EarningsRunSource = PreparedEarningsSource | StructuredFallbackSource;

@Injectable()
export class EarningsSourceService {
  private readonly logger = new Logger(EarningsSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(US_FILING_PORT) private readonly usFilings: FilingPort,
    @Inject(CN_FILING_PORT) private readonly cnFilings: FilingPort,
  ) {}

  async discoverAndIngest(stock: Stock): Promise<PreparedEarningsSource> {
    const instrumentId = `${stock.market}:${stock.symbol}`;
    const port = stock.market === 'US' ? this.usFilings : stock.market === 'CN' ? this.cnFilings : null;
    if (!port?.getFiling) throw new EarningsSourceError('UNSUPPORTED_MARKET', false);

    const forms = stock.market === 'US'
      ? ['8-K', '10-Q', '10-K']
      : ['preview', 'preliminary', 'quarterly', 'semiannual', 'annual'];
    const listed = await port.searchFilings({ instrumentId, forms, limit: stock.market === 'US' ? 12 : 10 });
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
      return this.persist(stock, summary, document);
    }

    if (failures.length === 0) {
      throw new EarningsSourceError('NO_NEW_ELIGIBLE_FILING', true);
    }
    throw new EarningsSourceError('BODY_UNREADABLE', true, failures.join('; '), fallbackSource);
  }

  private async persist(
    stock: Stock,
    summary: FilingSummary,
    document: FilingDocument,
  ): Promise<PreparedEarningsSource> {
    const normalizedText = document.text;
    const contentHash = document.contentHash;
    const rawContent = document.rawContent;
    if (!normalizedText || !contentHash || !rawContent) {
      throw new EarningsSourceError('BODY_UNREADABLE', true);
    }
    const provider = document.provider || summary.provider;
    const sourceDocumentId = document.sourceDocumentId;
    const existing = await this.prisma.filing.findUnique({
      where: { provider_sourceDocumentId: { provider, sourceDocumentId } },
    });
    if (existing && existing.contentHash !== contentHash) {
      throw new EarningsSourceError(
        'FILING_CONTENT_CHANGED',
        false,
        `${provider}:${sourceDocumentId} changed content without a new source id`,
      );
    }

    const filing =
      existing ??
      (await this.prisma.filing.create({
        data: {
          stockId: stock.id,
          provider,
          sourceDocumentId,
          sourceGroupId: document.sourceGroupId ?? summary.sourceGroupId,
          formType: summary.formType,
          documentKind: document.documentKind ?? 'OTHER',
          title: summary.title,
          sourceUrl: document.filingUrl,
          publishedAt: parsePublishedAt(summary.filingDate),
          retrievedAt: document.retrievedAt ? new Date(document.retrievedAt) : new Date(),
          mimeType: document.mimeType ?? 'text/plain',
          contentHash,
          rawContent: Buffer.from(rawContent),
        },
      }));

    const derivationContentHash = computeContentHash({ text: normalizedText });
    const derivationKey = buildParserDerivationKey(filing.id, filing.contentHash);
    const derivation = await this.prisma.filingDerivation.upsert({
      where: { derivationKey },
      update: {},
      create: {
        filingId: filing.id,
        derivationKey,
        parserVersion: PARSER_VERSION,
        modelVersion: 'none',
        promptVersion: 'none',
        schemaVersion: DERIVATION_SCHEMA_VERSION,
        status: 'COMPLETE',
        normalizedText,
        contentHash: derivationContentHash,
        pages: document.pages
          ? (document.pages as unknown as Prisma.InputJsonValue)
          : undefined,
        sections: sectionizeFilingText(
          normalizedText,
          document.pages?.map((page) => ({
            page: page.page,
            startOffset: page.startOffset,
            endOffset: page.endOffset,
          })),
        ) as unknown as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`prepared ${provider}:${sourceDocumentId} for ${stock.market}:${stock.symbol}`);
    return {
      kind: 'filing',
      filingId: filing.id,
      derivationId: derivation.id,
      provider,
      sourceDocumentId,
      sourceGroupId: document.sourceGroupId,
      formType: summary.formType,
      title: summary.title,
      sourceUrl: document.filingUrl,
      publishedAt: filing.publishedAt.toISOString(),
      ...(summary.periodEndOn ? { expectedPeriodEndOn: summary.periodEndOn } : {}),
      documentKind: document.documentKind ?? 'OTHER',
      contentHash: filing.contentHash,
      normalizedText,
      derivationContentHash,
      pages: document.pages,
    };
  }
}

export function buildParserDerivationKey(filingId: string, filingHash: string): string {
  return computeContentHash({
    text: JSON.stringify({
      filingId,
      filingHash,
      parserVersion: PARSER_VERSION,
      modelVersion: 'none',
      promptVersion: 'none',
      schemaVersion: DERIVATION_SCHEMA_VERSION,
    }),
  });
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
    reason: 'BODY_UNREADABLE',
  };
}
