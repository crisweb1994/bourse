import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreateScreeningRunRequestSchema,
  EquityScreenerSnapshotSchema,
  RefineResponseSchema,
  RefineScreeningRunRequestSchema,
  SavedScreenDtoSchema,
  SavedScreenPatchSchema,
  SavedScreenPayloadSchema,
  ScreeningConfigSchema,
  ScreeningQuerySchema,
  ScreeningRefinementDtoSchema,
  ScreeningRefinementPayloadSchema,
  ScreeningRunDtoSchema,
  ScreeningViewSchema,
  type CreateScreeningRunRequest,
  type EquityScreenerSnapshot,
  type RefineCandidateResult,
  type RefineResponse,
  type SavedScreenDto,
  type ScreeningConfig,
  type ScreeningMetricCell,
  type ScreeningQuery,
  type ScreeningRefinementDto,
  type ScreeningRefinementPayload,
  type ScreeningRunDto,
  type ScreeningView,
} from '@bourse/shared-types';
import {
  type CompanyProfile,
  type FinancialsBundle,
  type PriceBar,
  type Quote,
  type ResearchMarketDataClient,
  type ResearchResultV2,
  type ResearchWarning,
} from '@bourse/market-data';
import {
  computeFinancialRatios,
  computeTechnicalIndicators,
} from '@bourse/analysis';
import { MARKET_DATA_CLIENT } from '../connectors/connectors.module';
import { PrismaService } from '../prisma/prisma.service';
import { availablePresets } from './screening-presets';

const MAX_REFINEMENTS_PER_RUN = 50;
const REFINEMENT_CONCURRENCY = 2;
const DAY_MS = 86_400_000;
const PERSISTABLE_MARKET_DATA_CONSTRAINTS = {
  acceptedRedistribution: [
    'public-cache-allowed',
    'credential-cache-only',
  ],
} as const;
const REFINEMENT_FAILED_MESSAGE = 'Candidate refinement failed.';
const PERSISTENCE_NOT_ALLOWED_MESSAGE =
  '当前筛选数据源不允许保存候选快照，因此未启用。';
const SCREENER_UNAVAILABLE_MESSAGE = '当前市场暂无可用的筛选数据源。';
const REFINEMENT_RESERVATION = { reservation: true } as const;

const DEFAULT_VIEW: ScreeningView = ScreeningViewSchema.parse({
  visibleColumns: [
    'SECURITY',
    'PRICE',
    'SORT_METRIC',
    'CONDITION_MATCH',
    'PE',
    'PB',
    'ROE',
    'RSI14',
    'REFINE_STATUS',
  ],
});

type JsonDate = Date | string;

interface RefinementRow {
  identityKey: string;
  payload: unknown;
  createdAt: JsonDate;
  updatedAt: JsonDate;
}

interface RunRow {
  id: string;
  savedScreenId: string | null;
  query: unknown;
  sourceId: string;
  capturedAt: JsonDate;
  snapshot: unknown;
  createdAt: JsonDate;
  savedScreen?: { view: unknown } | null;
  refinements: RefinementRow[];
}

interface SavedScreenRow {
  id: string;
  name: string;
  query: unknown;
  view: unknown;
  createdAt: JsonDate;
  updatedAt: JsonDate;
}

interface LockedRunRow {
  id: string;
  query: unknown;
  snapshot: unknown;
}

@Injectable()
export class ScreeningService {
  private readonly logger = new Logger(ScreeningService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MARKET_DATA_CLIENT)
    private readonly marketData: ResearchMarketDataClient,
  ) {}

  async config(marketInput?: string): Promise<ScreeningConfig> {
    const market = parseMarket(marketInput);
    const result = await this.marketData.describeEquityScreener(market, {
      timeoutMs: 15_000,
    }, PERSISTABLE_MARKET_DATA_CONSTRAINTS);

    if (result.status !== 'ok' && result.status !== 'partial') {
      return ScreeningConfigSchema.parse({
        market,
        available: false,
        unavailableReason:
          providerFailureCode(result) === 'PERMISSION_DENIED'
            ? PERSISTENCE_NOT_ALLOWED_MESSAGE
            : SCREENER_UNAVAILABLE_MESSAGE,
        sourceId: null,
        metrics: [],
        sortableMetrics: [],
        delay: null,
        universeLabel: '活跃普通股',
        universeRules: [],
        presets: [],
      });
    }

    const descriptor = result.data;
    return ScreeningConfigSchema.parse({
      market,
      available: true,
      unavailableReason: null,
      sourceId: selectedSource(result),
      metrics: descriptor.metrics.map((entry) => ({
        metric: entry.metric,
        operators: [...entry.operators],
      })),
      sortableMetrics: [...descriptor.sortableMetrics],
      delay: descriptor.delay,
      universeLabel: descriptor.universeLabel,
      universeRules: [...descriptor.universeRules],
      presets: availablePresets(market, descriptor),
    });
  }

  async createRun(userId: string, input: unknown): Promise<ScreeningRunDto> {
    const request = parseInput(
      CreateScreeningRunRequestSchema,
      input,
      'Invalid screening run request.',
    );

    const savedScreen = request.savedScreenId
      ? await this.prisma.savedScreen.findFirst({
          where: { id: request.savedScreenId, userId },
          select: { id: true, view: true },
        })
      : null;
    if (request.savedScreenId && !savedScreen) {
      throw new NotFoundException('Saved screen not found');
    }

    const descriptorResult = await this.marketData.describeEquityScreener(
      request.query.market,
      { timeoutMs: 15_000 },
      PERSISTABLE_MARKET_DATA_CONSTRAINTS,
    );
    if (
      descriptorResult.status !== 'ok' &&
      descriptorResult.status !== 'partial'
    ) {
      throwProviderFailure(descriptorResult, true);
    }
    validateProviderCapabilities(request.query, descriptorResult.data);

    const screenResult = await this.marketData.screenEquities(request.query, {
      timeoutMs: 15_000,
    }, PERSISTABLE_MARKET_DATA_CONSTRAINTS);
    if (screenResult.status !== 'ok' && screenResult.status !== 'partial') {
      throwProviderFailure(screenResult, false);
    }

    const parsedSnapshot = EquityScreenerSnapshotSchema.safeParse({
      ...screenResult.data,
      warnings: normalizeScreeningWarnings(screenResult.warnings),
    });
    if (!parsedSnapshot.success) {
      throw new BadGatewayException('Screener provider returned an invalid snapshot');
    }
    const snapshot = prepareSnapshot(parsedSnapshot.data, request.query);
    const sourceId = selectedSource(screenResult);
    if (!sourceId) {
      throw new BadGatewayException('Screener provider omitted source provenance');
    }

    const capturedAt = new Date();
    const row = await this.prisma.screeningRun.create({
      data: {
        userId,
        savedScreenId: request.savedScreenId ?? null,
        query: toPrismaJson(request.query),
        sourceId,
        capturedAt,
        snapshot: toPrismaJson(snapshot),
      },
      include: {
        savedScreen: { select: { view: true } },
        refinements: true,
      },
    });

    return mapRun(row as unknown as RunRow);
  }

  async getRun(userId: string, id: string): Promise<ScreeningRunDto> {
    const row = await this.prisma.screeningRun.findFirst({
      where: { id, userId },
      include: {
        savedScreen: { select: { view: true } },
        refinements: { orderBy: { identityKey: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('Screening run not found');
    return mapRun(row as unknown as RunRow);
  }

  async refineRun(
    userId: string,
    id: string,
    input: unknown,
  ): Promise<RefineResponse> {
    const request = parseInput(
      RefineScreeningRunRequestSchema,
      input,
      'Invalid refinement request.',
    );
    const query = await this.reserveRefinementSlots(
      userId,
      id,
      request.identityKeys,
    );

    const results: RefineCandidateResult[] = [];
    for (
      let offset = 0;
      offset < request.identityKeys.length;
      offset += REFINEMENT_CONCURRENCY
    ) {
      const batch = request.identityKeys.slice(
        offset,
        offset + REFINEMENT_CONCURRENCY,
      );
      const settled = await Promise.allSettled(
        batch.map((identityKey) =>
          this.refineCandidate(id, query, identityKey),
        ),
      );
      settled.forEach((result, index) => {
        const identityKey = batch[index]!;
        if (result.status === 'rejected') {
          this.logger.error(
            `Refinement failed for run ${id}, candidate ${identityKey}.`,
          );
        }
        results.push(
          result.status === 'fulfilled'
            ? result.value
            : {
                identityKey,
                status: 'FAILED',
                error: REFINEMENT_FAILED_MESSAGE,
              },
        );
      });
    }

    return RefineResponseSchema.parse({ results });
  }

  async listSavedScreens(userId: string): Promise<SavedScreenDto[]> {
    const rows = await this.prisma.savedScreen.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((row) => mapSavedScreen(row as unknown as SavedScreenRow));
  }

  async createSavedScreen(
    userId: string,
    input: unknown,
  ): Promise<SavedScreenDto> {
    const payload = parseInput(
      SavedScreenPayloadSchema,
      input,
      'Invalid saved screen.',
    );
    const row = await this.prisma.savedScreen.create({
      data: {
        userId,
        name: payload.name,
        query: toPrismaJson(payload.query),
        view: toPrismaJson(payload.view),
      },
    });
    return mapSavedScreen(row as unknown as SavedScreenRow);
  }

  async updateSavedScreen(
    userId: string,
    id: string,
    input: unknown,
  ): Promise<SavedScreenDto> {
    const patch = parseInput(
      SavedScreenPatchSchema,
      input,
      'Invalid saved screen update.',
    );

    const updated = await this.prisma.savedScreen.updateMany({
      where: { id, userId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.query !== undefined
          ? { query: toPrismaJson(patch.query) }
          : {}),
        ...(patch.view !== undefined
          ? { view: toPrismaJson(patch.view) }
          : {}),
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Saved screen not found');
    }

    const row = await this.prisma.savedScreen.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('Saved screen not found');
    return mapSavedScreen(row as unknown as SavedScreenRow);
  }

  async deleteSavedScreen(
    userId: string,
    id: string,
  ): Promise<{ ok: true }> {
    const deleted = await this.prisma.savedScreen.deleteMany({
      where: { id, userId },
    });
    if (deleted.count === 0) {
      throw new NotFoundException('Saved screen not found');
    }
    return { ok: true };
  }

  private async reserveRefinementSlots(
    userId: string,
    runId: string,
    identityKeys: string[],
  ): Promise<ScreeningQuery> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedRunRow[]>(Prisma.sql`
        SELECT "id", "query", "snapshot"
        FROM "ScreeningRun"
        WHERE "id" = ${runId} AND "userId" = ${userId}
        FOR UPDATE
      `);
      const run = rows[0];
      if (!run) throw new NotFoundException('Screening run not found');

      const query = ScreeningQuerySchema.parse(run.query);
      const snapshot = EquityScreenerSnapshotSchema.parse(run.snapshot);
      const candidates = new Set(
        snapshot.items.map((candidate) => candidate.identityKey),
      );
      for (const identityKey of identityKeys) {
        if (!candidates.has(identityKey)) {
          throw new BadRequestException({
            message: 'Candidate does not belong to this screening run.',
            code: 'UNKNOWN_SCREENING_CANDIDATE',
            identityKey,
          });
        }
      }

      const refinements = await tx.screeningRefinement.findMany({
        where: { runId },
        select: { identityKey: true },
      });
      const existing = new Set(
        refinements.map((refinement) => refinement.identityKey),
      );
      const additions = identityKeys.filter((key) => !existing.has(key));
      if (existing.size + additions.length > MAX_REFINEMENTS_PER_RUN) {
        throw new BadRequestException({
          message: `A screening run can refine at most ${MAX_REFINEMENTS_PER_RUN} candidates.`,
          code: 'REFINEMENT_LIMIT_EXCEEDED',
        });
      }

      if (additions.length > 0) {
        const payload = toPrismaJson(REFINEMENT_RESERVATION);
        await tx.screeningRefinement.createMany({
          data: additions.map((identityKey) => ({
            runId,
            identityKey,
            payload,
          })),
          skipDuplicates: true,
        });
      }
      return query;
    });
  }

  private async refineCandidate(
    runId: string,
    query: ScreeningQuery,
    identityKey: string,
  ): Promise<RefineCandidateResult> {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 400 * DAY_MS).toISOString().slice(0, 10);
    const context = { timeoutMs: 15_000 };
    const [quote, profile, financials, history] = await Promise.all([
      marketCall(() => this.marketData.getQuote(
        identityKey,
        context,
        PERSISTABLE_MARKET_DATA_CONSTRAINTS,
      )),
      marketCall(() => this.marketData.getProfile(
        identityKey,
        context,
        PERSISTABLE_MARKET_DATA_CONSTRAINTS,
      )),
      marketCall(() => this.marketData.getFinancials(
        identityKey,
        context,
        PERSISTABLE_MARKET_DATA_CONSTRAINTS,
      )),
      marketCall(() =>
        this.marketData.getHistory(
          { instrumentId: identityKey, from, to, interval: '1d' },
          context,
          PERSISTABLE_MARKET_DATA_CONSTRAINTS,
        ),
      ),
    ]);

    if ([quote, profile, financials, history].every(isFailed)) {
      return {
        identityKey,
        status: 'FAILED',
        error: REFINEMENT_FAILED_MESSAGE,
      };
    }

    const payload = buildRefinement(
      query.market,
      quote,
      profile,
      financials,
      history,
    );
    const row = await this.prisma.screeningRefinement.upsert({
      where: { runId_identityKey: { runId, identityKey } },
      create: {
        runId,
        identityKey,
        payload: toPrismaJson(payload),
      },
      update: { payload: toPrismaJson(payload) },
    });
    const refinement = mapRefinement(row as unknown as RefinementRow);
    return {
      identityKey,
      status: payload.status,
      refinement,
    };
  }
}

function parseMarket(value?: string): ScreeningQuery['market'] {
  const market = value?.trim().toUpperCase();
  if (market !== 'US' && market !== 'CN' && market !== 'HK') {
    throw new BadRequestException('market must be one of US | CN | HK');
  }
  return market;
}

function parseInput<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | {
          success: false;
          error: {
            issues: Array<{ path: Array<string | number>; message: string }>;
          };
        };
  },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const conditionIndex = parsed.error.issues
    .map((issue) => {
      const conditionsOffset = issue.path.indexOf('conditions');
      const candidate = issue.path[conditionsOffset + 1];
      return typeof candidate === 'number' ? candidate : null;
    })
    .find((candidate): candidate is number => candidate !== null);
  throw new BadRequestException({
    message,
    ...(conditionIndex !== undefined ? { conditionIndex } : {}),
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

function prepareSnapshot(
  snapshot: EquityScreenerSnapshot,
  query: ScreeningQuery,
): EquityScreenerSnapshot {
  if (
    snapshot.conditionCounts &&
    snapshot.conditionCounts.length !== query.conditions.length
  ) {
    throw new BadGatewayException(
      'Screener provider returned invalid condition counts',
    );
  }
  const uniqueItems = [
    ...new Map(
      snapshot.items.map((candidate) => [candidate.identityKey, candidate]),
    ).values(),
  ];
  return EquityScreenerSnapshotSchema.parse({
    ...snapshot,
    items: uniqueItems,
  });
}

function normalizeScreeningWarnings(
  warnings: readonly ResearchWarning[],
): NonNullable<EquityScreenerSnapshot['warnings']> {
  return warnings.slice(0, 20).map((warning) => {
    const provider = warning.provider?.trim().slice(0, 100);
    const retryAfterMs = warning.retryAfterMs;
    return {
      code: warning.code.slice(0, 64),
      message: safeProviderWarningMessage(warning.code),
      ...(provider ? { provider } : {}),
      ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
        ? {
            retryAfterMs: Math.min(
              86_400_000,
              Math.max(0, Math.round(retryAfterMs)),
            ),
          }
        : {}),
    };
  });
}

function validateProviderCapabilities(
  query: ScreeningQuery,
  descriptor: {
    metrics: ReadonlyArray<{
      metric: ScreeningQuery['sort']['metric'];
      operators: readonly string[];
    }>;
    sortableMetrics: readonly ScreeningQuery['sort']['metric'][];
  },
): void {
  const metrics = new Map(
    descriptor.metrics.map((entry) => [entry.metric, new Set(entry.operators)]),
  );
  query.conditions.forEach((condition, conditionIndex) => {
    const operators = metrics.get(condition.metric);
    if (!operators) {
      throw new UnprocessableEntityException({
        message: `Provider does not support ${condition.metric}.`,
        code: 'UNSUPPORTED_METRIC',
        conditionIndex,
      });
    }
    if (!operators.has(condition.operator)) {
      throw new UnprocessableEntityException({
        message: `Provider does not support ${condition.operator} for ${condition.metric}.`,
        code: 'UNSUPPORTED_OPERATOR',
        conditionIndex,
      });
    }
  });
  if (!descriptor.sortableMetrics.includes(query.sort.metric)) {
    throw new UnprocessableEntityException({
      message: `Provider cannot sort by ${query.sort.metric}.`,
      code: 'UNSUPPORTED_SORT',
    });
  }
}

function throwProviderFailure(
  result: ResearchResultV2<unknown>,
  unavailable: boolean,
): never {
  const error =
    result.status === 'failed' || result.status === 'empty'
      ? result.error
      : undefined;
  const code = providerFailureCode(result);
  const retryAfterMs =
    error?.retryAfterMs ??
    result.warnings.find((warning) => warning.retryAfterMs)?.retryAfterMs;
  if (code === 'RATE_LIMITED') {
    throw new HttpException(
      {
        message: 'Screener provider is rate limited.',
        code: 'SCREENER_RATE_LIMITED',
        retryAfterMs,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  if (code === 'PERMISSION_DENIED') {
    throw new ServiceUnavailableException({
      message: PERSISTENCE_NOT_ALLOWED_MESSAGE,
      code: 'SCREENER_PERSISTENCE_NOT_ALLOWED',
    });
  }
  if (
    unavailable ||
    code === 'UNSUPPORTED_CAPABILITY' ||
    code === 'UNSUPPORTED_MARKET' ||
    code === 'CONFIG_MISSING' ||
    code === 'AUTH_REQUIRED'
  ) {
    throw new ServiceUnavailableException({
      message: 'No usable screener provider is configured for this market.',
      code: 'SCREENER_UNAVAILABLE',
    });
  }
  throw new BadGatewayException({
    message: 'Screener provider did not return a usable snapshot.',
    code: 'SCREENER_PROVIDER_FAILED',
  });
}

function providerFailureCode(result: ResearchResultV2<unknown>): string | undefined {
  const error =
    result.status === 'failed' || result.status === 'empty'
      ? result.error
      : undefined;
  return error?.code ?? result.warnings[0]?.code;
}

function selectedSource(result: ResearchResultV2<unknown>): string | null {
  return (
    ('selectedSource' in result.trace ? result.trace.selectedSource : undefined) ??
    result.trace.attempts.find((attempt) => attempt.outcome === 'hit')?.sourceId ??
    null
  );
}

function mapSavedScreen(row: SavedScreenRow): SavedScreenDto {
  return SavedScreenDtoSchema.parse({
    id: row.id,
    name: row.name,
    query: ScreeningQuerySchema.parse(row.query),
    view: ScreeningViewSchema.parse(row.view),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  });
}

function mapRefinement(row: RefinementRow): ScreeningRefinementDto {
  return ScreeningRefinementDtoSchema.parse({
    identityKey: row.identityKey,
    payload: ScreeningRefinementPayloadSchema.parse(row.payload),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  });
}

function mapRun(row: RunRow): ScreeningRunDto {
  const snapshot = EquityScreenerSnapshotSchema.parse(row.snapshot);
  return ScreeningRunDtoSchema.parse({
    id: row.id,
    savedScreenId: row.savedScreenId ?? null,
    status: snapshot.complete ? 'COMPLETE' : 'PARTIAL',
    query: ScreeningQuerySchema.parse(row.query),
    sourceId: row.sourceId,
    capturedAt: toIso(row.capturedAt),
    createdAt: toIso(row.createdAt),
    snapshot,
    view: row.savedScreen
      ? ScreeningViewSchema.parse(row.savedScreen.view)
      : DEFAULT_VIEW,
    refinements: row.refinements
      .filter((refinement) => !isRefinementReservation(refinement.payload))
      .map(mapRefinement),
  });
}

function toIso(value: JsonDate): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isRefinementReservation(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).reservation === true
  );
}

async function marketCall<T>(
  call: () => Promise<ResearchResultV2<T>>,
): Promise<ResearchResultV2<T>> {
  try {
    return await call();
  } catch (error) {
    return {
      schemaVersion: '2.0',
      status: 'failed',
      data: null,
      citations: [],
      freshness: [],
      warnings: [],
      trace: { attempts: [] },
      error: {
        code: 'SOURCE_UNAVAILABLE',
        message: errorMessage(error),
      },
    };
  }
}

function buildRefinement(
  market: ScreeningQuery['market'],
  quote: ResearchResultV2<Quote>,
  profile: ResearchResultV2<CompanyProfile>,
  financials: ResearchResultV2<FinancialsBundle>,
  history: ResearchResultV2<PriceBar[]>,
): ScreeningRefinementPayload {
  const bars = (history.data ?? []).slice(-260);
  const ratiosOutput = computeFinancialRatios({
    bundle: financials.data,
    quote: quote.data,
    market,
  });
  const technicalOutput = computeTechnicalIndicators({ bars });
  const ratios = ratiosOutput.ratios;
  const technical = technicalOutput.indicators;
  const quoteAsOf = quote.data?.timestamp ?? quote.freshness[0]?.asOf ?? null;
  const financialAsOf =
    financials.data?.periods[0]?.fiscalYearEnd ??
    financials.data?.retrievedAt ??
    null;
  const valuationAsOf = earliestAsOf(financialAsOf, quoteAsOf);
  const financialInputs = inputSources(financials, quote);
  const financialNote = financialInputs.length
    ? `Inputs: ${financialInputs.join(', ')}`
    : undefined;
  const financialFailed = isFailed(financials);
  const valuationFailed = financialFailed || isFailed(quote);
  const technicalFailed = isFailed(history);
  const profileSource = selectedSource(profile) ?? 'market-data';
  const profileAsOf = profile.freshness[0]?.asOf ?? null;
  const quoteSource = selectedSource(quote) ?? 'market-data';
  const quoteMarketCap = quote.data?.marketCap;
  const profileMarketCap = profile.data?.marketCap;
  const marketCapFromQuote = quoteMarketCap !== undefined;
  const atr14Pct =
    technical?.atr14 != null &&
    technical.lastClose != null &&
    technical.lastClose !== 0
      ? technical.atr14 / technical.lastClose
      : null;

  const cells: Record<string, ScreeningMetricCell> = {
    PRICE: directCell(
      quote.data?.price ?? null,
      'CURRENCY',
      quoteAsOf,
      isFailed(quote),
      quoteSource,
    ),
    MARKET_CAP: directCell(
      quoteMarketCap ?? profileMarketCap ?? null,
      'CURRENCY',
      marketCapFromQuote ? quoteAsOf : profileAsOf,
      marketCapFromQuote ? isFailed(quote) : isFailed(profile),
      marketCapFromQuote ? quoteSource : profileSource,
    ),
    SECTOR: directCell(
      profile.data?.sector ?? null,
      'ENUM',
      profileAsOf,
      isFailed(profile),
      profileSource,
    ),
    INDUSTRY: directCell(
      profile.data?.industry ?? null,
      'ENUM',
      profileAsOf,
      isFailed(profile),
      profileSource,
    ),
    PE: computedCell(ratios?.pe ?? null, 'RATIO', valuationAsOf, valuationFailed, financialNote),
    PB: computedCell(ratios?.pb ?? null, 'RATIO', valuationAsOf, valuationFailed, financialNote),
    PS: computedCell(ratios?.ps ?? null, 'RATIO', valuationAsOf, valuationFailed, financialNote),
    FCF_YIELD: computedCell(ratios?.fcfYield ?? null, 'PERCENT', valuationAsOf, valuationFailed, financialNote),
    GROSS_MARGIN: computedCell(ratios?.grossMargin ?? null, 'PERCENT', financialAsOf, financialFailed, financialNote),
    OPERATING_MARGIN: computedCell(ratios?.operatingMargin ?? null, 'PERCENT', financialAsOf, financialFailed, financialNote),
    NET_MARGIN: computedCell(ratios?.netMargin ?? null, 'PERCENT', financialAsOf, financialFailed, financialNote),
    ROE: computedCell(ratios?.roe ?? null, 'PERCENT', financialAsOf, financialFailed, financialNote),
    REVENUE_GROWTH_YOY: computedCell(ratios?.revenueGrowthYoY ?? null, 'PERCENT', financialAsOf, financialFailed, financialNote),
    EARNINGS_GROWTH_YOY: computedCell(ratios?.earningsGrowthYoY ?? null, 'PERCENT', financialAsOf, financialFailed, financialNote),
    DEBT_TO_EQUITY: computedCell(ratios?.debtToEquity ?? null, 'RATIO', financialAsOf, financialFailed, financialNote),
    CURRENT_RATIO: computedCell(ratios?.currentRatio ?? null, 'RATIO', financialAsOf, financialFailed, financialNote),
    INTEREST_COVERAGE: computedCell(ratios?.interestCoverage ?? null, 'RATIO', financialAsOf, financialFailed, financialNote),
    PRICE_VS_SMA20: computedCell(relativeTo(technical?.lastClose, technical?.sma20), 'PERCENT', technical?.asOf ?? null, technicalFailed),
    PRICE_VS_SMA50: computedCell(relativeTo(technical?.lastClose, technical?.sma50), 'PERCENT', technical?.asOf ?? null, technicalFailed),
    PRICE_VS_SMA200: computedCell(relativeTo(technical?.lastClose, technical?.sma200), 'PERCENT', technical?.asOf ?? null, technicalFailed),
    RSI14: computedCell(technical?.rsi14 ?? null, 'RATIO', technical?.asOf ?? null, technicalFailed),
    MACD_STATE: computedCell(technical?.macdTrend ?? null, 'ENUM', technical?.asOf ?? null, technicalFailed),
    ATR14_PCT: computedCell(atr14Pct, 'PERCENT', technical?.asOf ?? null, technicalFailed),
  };

  const providerWarnings = [quote, profile, financials, history].flatMap(
    safeResultWarnings,
  );
  const warnings = [
    ...providerWarnings,
    ...ratiosOutput.warnings.map((warning) => warning.detail),
    ...technicalOutput.warnings.map((warning) => warning.detail),
  ];
  const payload = {
    status: [quote, profile, financials, history].every(
      (result) => result.status === 'ok',
    )
      ? ('COMPLETE' as const)
      : ('PARTIAL' as const),
    cells,
    warnings: [...new Set(warnings)],
    completedAt: new Date().toISOString(),
  };
  return ScreeningRefinementPayloadSchema.parse(payload);
}

function directCell(
  value: number | string | null,
  unit: ScreeningMetricCell['unit'],
  asOf: string | null,
  failed: boolean,
  sourceId: string,
): ScreeningMetricCell {
  return {
    status: value !== null ? 'PRESENT' : failed ? 'FETCH_FAILED' : 'MISSING',
    value,
    unit,
    sourceId,
    asOf,
    estimated: false,
  };
}

function computedCell(
  value: number | string | null,
  unit: ScreeningMetricCell['unit'],
  asOf: string | null,
  failed: boolean,
  note?: string,
): ScreeningMetricCell {
  return {
    status: value !== null ? 'PRESENT' : failed ? 'FETCH_FAILED' : 'MISSING',
    value,
    unit,
    sourceId: 'bourse-compute',
    asOf,
    estimated: true,
    ...(note ? { note } : {}),
  };
}

function relativeTo(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): number | null {
  return numerator !== null &&
    numerator !== undefined &&
    denominator !== null &&
    denominator !== undefined &&
    denominator !== 0
    ? numerator / denominator - 1
    : null;
}

function earliestAsOf(...values: Array<string | null>): string | null {
  const valid = values
    .filter((value): value is string => value !== null)
    .map((value) => ({ value, timestamp: new Date(value).getTime() }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  return valid[0]?.value ?? null;
}

function isFailed(result: ResearchResultV2<unknown>): boolean {
  return result.status === 'failed';
}

function inputSources(...results: ResearchResultV2<unknown>[]): string[] {
  return [
    ...new Set(
      results
        .map(selectedSource)
        .filter((source): source is string => source !== null),
    ),
  ];
}

function safeResultWarnings(result: ResearchResultV2<unknown>): string[] {
  const codes: string[] = result.warnings.map((warning) => warning.code);
  if (
    (result.status === 'failed' || result.status === 'empty') &&
    result.error?.code
  ) {
    codes.push(result.error.code);
  }
  return [...new Set(codes)].map(
    (code) => `${code}: ${safeProviderWarningMessage(code)}`,
  );
}

function safeProviderWarningMessage(code: string): string {
  switch (code) {
    case 'RATE_LIMITED':
      return '数据源请求受限，请稍后重试。';
    case 'PERMISSION_DENIED':
    case 'REDISTRIBUTION_FORBIDDEN':
    case 'REDISTRIBUTION_LIMITED':
      return '当前数据源不允许保存该项数据。';
    case 'AUTH_REQUIRED':
    case 'AUTH_INVALID':
      return '数据源认证不可用。';
    case 'UNSUPPORTED_CAPABILITY':
    case 'UNSUPPORTED_DATASET':
    case 'UNSUPPORTED_SERIES':
    case 'UNSUPPORTED_MARKET':
    case 'UNSUPPORTED_SECURITY_TYPE':
    case 'UNSUPPORTED_INTERVAL':
    case 'UNSUPPORTED_REQUEST':
      return '当前数据源不支持该项数据。';
    case 'STALE_DATA':
    case 'DELAYED_DATA':
      return '部分数据可能不是最新。';
    case 'PARTIAL_DATA':
    case 'PARTIAL_COVERAGE':
    case 'FIELD_DROPPED':
      return '部分数据未能获取，结果可能不完整。';
    case 'MARKET_CLOSED':
      return '市场当前处于休市状态。';
    default:
      return '数据源返回了受限或不完整的数据。';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
