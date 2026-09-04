import type {
  FilingDocument,
} from '@bourse/market-data';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { ResearchMarketDataClient } from '@bourse/market-data';
import type { Stock } from '@prisma/client';
import { MARKET_DATA_CLIENT } from '../connectors/connectors.module';
import { FilingStoreError, FilingStoreService } from '../filings/filing-store.service';
import { PrismaService } from '../prisma/prisma.service';

export interface PreparedInvestorRelationsSource {
  filingId: string;
  derivationId: string;
  provider: string;
  sourceDocumentId: string;
  sourceGroupId?: string;
  formType: string;
  title?: string;
  sourceUrl: string;
  publishedAt: string;
  contentHash: string;
  language?: FilingDocument['language'];
}

export class InvestorRelationsSourceError extends Error {
  constructor(public readonly code: string, public readonly retryable: boolean, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

@Injectable()
export class InvestorRelationsSourceService {
  private readonly logger = new Logger(InvestorRelationsSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MARKET_DATA_CLIENT) private readonly marketData: ResearchMarketDataClient,
    private readonly filingStore: FilingStoreService,
  ) {}

  async discoverAndIngest(stock: Stock): Promise<PreparedInvestorRelationsSource> {
    if (stock.market !== 'CN') {
      throw new InvestorRelationsSourceError('UNSUPPORTED_MARKET', false);
    }
    const listed = await this.marketData.listFilings({
      instrumentId: `CN:${stock.symbol}`,
      forms: ['investor_relations'],
      limit: 20,
    });
    if (!listed.data?.length) {
      throw new InvestorRelationsSourceError('NO_ELIGIBLE_IR_RECORD', true, listed.warnings[0]?.message);
    }
    const failures: string[] = [];
    for (const summary of listed.data) {
      const linked = await this.prisma.filing.findUnique({
        where: { provider_sourceDocumentId: { provider: summary.provider, sourceDocumentId: summary.sourceDocumentId } },
        select: { investorRelationsEventLinks: { take: 1, select: { eventId: true } } },
      });
      if (linked?.investorRelationsEventLinks.length) continue;
      try {
        const result = await this.marketData.getFilingDocument({ ...summary });
        if (!result.data?.text || !result.data.contentHash) {
          failures.push(result.warnings[0]?.message ?? `${summary.sourceDocumentId}: unreadable body`);
          continue;
        }
        const stored = await this.filingStore.persist(stock, summary, result.data);
        this.logger.log(`prepared IR ${stored.filing.provider}:${stored.filing.sourceDocumentId}`);
        return {
          filingId: stored.filing.id,
          derivationId: stored.derivation.id,
          provider: stored.filing.provider,
          sourceDocumentId: stored.filing.sourceDocumentId,
          sourceGroupId: stored.filing.sourceGroupId ?? undefined,
          formType: stored.filing.formType,
          title: stored.filing.title ?? undefined,
          sourceUrl: stored.filing.sourceUrl,
          publishedAt: stored.filing.publishedAt.toISOString(),
          contentHash: stored.filing.contentHash,
          language: result.data.language,
        };
      } catch (error) {
        if (error instanceof FilingStoreError) {
          failures.push(error.code);
        } else {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (failures.length === 0) throw new InvestorRelationsSourceError('NO_NEW_IR_RECORD', true);
    throw new InvestorRelationsSourceError('BODY_UNREADABLE', true, failures.join('; '));
  }
}
