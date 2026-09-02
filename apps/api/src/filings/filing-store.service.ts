import type {
  FilingDocument,
  FilingSummary,
} from '@bourse/market-data';
import { Injectable } from '@nestjs/common';
import {
  computeContentHash,
  sectionizeFilingText,
} from '@bourse/analysis';
import { Prisma, type Stock } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const PARSER_VERSION = 'filing-text-v3';
const DERIVATION_SCHEMA_VERSION = 'filing-derivation-v3';

export class FilingStoreError extends Error {
  constructor(public readonly code: 'BODY_UNREADABLE' | 'FILING_CONTENT_CHANGED') {
    super(code);
  }
}

@Injectable()
export class FilingStoreService {
  constructor(private readonly prisma: PrismaService) {}

  async persist(stock: Stock, summary: FilingSummary, document: FilingDocument) {
    const normalizedText = document.text;
    const contentHash = document.contentHash;
    if (!normalizedText || !contentHash) throw new FilingStoreError('BODY_UNREADABLE');
    const provider = document.provider || summary.provider;
    const sourceDocumentId = document.sourceDocumentId;
    const existing = await this.prisma.filing.findUnique({
      where: { provider_sourceDocumentId: { provider, sourceDocumentId } },
    });
    if (existing && existing.contentHash !== contentHash) throw new FilingStoreError('FILING_CONTENT_CHANGED');
    const filing = existing ?? await this.prisma.filing.create({
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
        language: document.language ?? summary.language,
        contentHash,
      },
    });
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
        pages: document.pages ? document.pages as unknown as Prisma.InputJsonValue : undefined,
        sections: sectionizeFilingText(
          normalizedText,
          document.pages?.map(({ page, startOffset, endOffset }) => ({ page, startOffset, endOffset })),
        ) as unknown as Prisma.InputJsonValue,
      },
    });
    return { filing, derivation, normalizedText, pages: document.pages };
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

function parsePublishedAt(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`INVALID_FILING_DATE:${value}`);
  return date;
}
