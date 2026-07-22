import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EarningsConsensusBundleSchema,
  type FinancePort,
} from '@bourse/analysis';
import { Prisma, type Stock } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CN_FINANCE_PORT, YAHOO_FINANCE_PORT } from '../connectors/connectors.module';
import type { ConsensusBenchmark } from '@bourse/analysis';

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

@Injectable()
export class EarningsConsensusService {
  private readonly logger = new Logger(EarningsConsensusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(CN_FINANCE_PORT) private readonly cnFinance: FinancePort,
    @Inject(YAHOO_FINANCE_PORT) private readonly yahooFinance: FinancePort,
  ) {}

  maxAgeMs(): number {
    const configured = Number(this.config.get<string>('EARNINGS_CONSENSUS_MAX_AGE_MS') ?? DEFAULT_MAX_AGE_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_AGE_MS;
  }

  async capture(stock: Stock): Promise<number> {
    const port = stock.market === 'CN' ? this.cnFinance : stock.market === 'US' ? this.yahooFinance : null;
    if (!port?.fetchEarningsConsensus) return 0;
    let result;
    try {
      result = await port.fetchEarningsConsensus({ instrumentId: `${stock.market}:${stock.symbol}` });
    } catch (error) {
      this.logger.warn(`consensus fetch failed for ${stock.market}:${stock.symbol}: ${String(error)}`);
      return 0;
    }
    if (!result.data) return 0;
    const parsed = EarningsConsensusBundleSchema.safeParse(result.data);
    if (!parsed.success) {
      this.logger.warn(`consensus schema rejected for ${stock.market}:${stock.symbol}`);
      return 0;
    }
    const citationUrl = result.citations[0]?.url;
    if (!citationUrl) return 0;
    const capturedAt = new Date();
    const expiresAt = new Date(new Date(parsed.data.asOf).getTime() + this.maxAgeMs());
    let count = 0;
    for (const estimate of parsed.data.estimates) {
      try {
        await this.prisma.earningsConsensusSnapshot.upsert({
          where: {
            stockId_metricCode_periodEndOn_periodType_provider_asOf: {
              stockId: stock.id,
              metricCode: estimate.metricCode,
              periodEndOn: new Date(`${estimate.periodEndOn}T00:00:00.000Z`),
              periodType: estimate.periodType,
              provider: result.citations[0]?.provider ?? stock.market.toLowerCase(),
              asOf: new Date(parsed.data.asOf),
            },
          },
          // A snapshot is an as-of record, not a mutable cache row. Updating
          // capturedAt here could move a pre-publication consensus into the
          // post-publication window and make historical comparisons disappear.
          // A later provider revision gets a new `asOf` identity instead.
          update: {},
          create: {
            stockId: stock.id,
            metricCode: estimate.metricCode,
            periodEndOn: new Date(`${estimate.periodEndOn}T00:00:00.000Z`),
            periodType: estimate.periodType,
            value: new Prisma.Decimal(estimate.value),
            unit: estimate.unit,
            currency: estimate.currency,
            asOf: new Date(parsed.data.asOf),
            capturedAt,
            provider: result.citations[0]?.provider ?? stock.market.toLowerCase(),
            sourceUrl: citationUrl,
            analystCount: estimate.analystCount ?? null,
            expiresAt,
          },
        });
        count += 1;
      } catch (error) {
        this.logger.warn(`consensus snapshot persist failed for ${stock.symbol}/${estimate.metricCode}: ${String(error)}`);
      }
    }
    return count;
  }

  async beforePublication(
    stockId: string,
    periodEndOn: string,
    metricCode?: string,
    filingPublishedAt?: string,
  ): Promise<ConsensusBenchmark[]> {
    const publishedAt = filingPublishedAt ? new Date(filingPublishedAt) : new Date();
    const snapshots = await this.prisma.earningsConsensusSnapshot.findMany({
      where: {
        stockId,
        periodEndOn: new Date(`${periodEndOn}T00:00:00.000Z`),
        ...(metricCode ? { metricCode } : {}),
        asOf: { lt: publishedAt },
        capturedAt: { lt: publishedAt },
        OR: [{ expiresAt: null }, { expiresAt: { gte: publishedAt } }],
      },
      orderBy: { asOf: 'desc' },
    });
    return snapshots.map((snapshot) => ({
      metricCode: snapshot.metricCode as ConsensusBenchmark['metricCode'],
      value: { kind: 'scalar', value: snapshot.value.toString() },
      unit: snapshot.unit as ConsensusBenchmark['unit'],
      currency: snapshot.currency ?? undefined,
      periodEndOn: snapshot.periodEndOn.toISOString().slice(0, 10),
      periodType: snapshot.periodType,
      asOf: snapshot.asOf.toISOString(),
      capturedAt: snapshot.capturedAt.toISOString(),
      provider: snapshot.provider,
      sourceUrl: snapshot.sourceUrl,
    }));
  }
}
