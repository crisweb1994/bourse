import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  EarningsMetricValueDto,
  EarningsTrendOptionDto,
  EarningsTrendSeriesDto,
} from '@bourse/shared-types';
import { EarningsCardPayloadSchema, type EarningsCardPayload, type MetricFact } from '@bourse/analysis';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface TrendFact {
  id: string;
  revisionId: string;
  eventId: string;
  metricFactId: string;
  metricCode: string;
  valueKind: 'SCALAR' | 'RANGE';
  scalarValue: Prisma.Decimal | null;
  rangeMin: Prisma.Decimal | null;
  rangeMax: Prisma.Decimal | null;
  unit: string;
  currency: string | null;
  periodStartOn?: string;
  periodEndOn: string;
  periodKind: string;
  accumulation: 'discrete' | 'YTD' | 'FY';
  accountingBasis: string;
  consolidationScope: 'consolidated' | 'parent' | 'unknown';
  reconcileStatus: string;
  derivationKind: 'SOURCE' | 'YTD_DIFFERENCE';
  inputMetricFactIds: string[];
  sourceUrl?: string;
  event: {
    fiscalYear: number;
    fiscalQuarter: number | null;
    periodType: string;
  };
}

type FingerprintFact = Pick<
  TrendFact,
  | 'metricCode'
  | 'valueKind'
  | 'unit'
  | 'currency'
  | 'periodKind'
  | 'accumulation'
  | 'accountingBasis'
  | 'consolidationScope'
  | 'derivationKind'
>;

@Injectable()
export class EarningsTrendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async options(stockId: string): Promise<EarningsTrendOptionDto[]> {
    await this.assertEnabledStock(stockId);
    const groups = new Map<string, EarningsTrendOptionDto>();
    for (const fact of await this.loadFacts(stockId)) {
      const fingerprint = factCompatibilityFingerprint(fact);
      const key = `${fact.metricCode}:${fingerprint}`;
      const current = groups.get(key);
      if (current) {
        current.availablePeriods += 1;
        continue;
      }
      groups.set(key, {
        metricCode: fact.metricCode,
        label: metricLabel(fact.metricCode),
        availablePeriods: 1,
        fingerprint,
        valueKind: fact.valueKind,
        unit: fact.unit,
        currency: fact.currency ?? undefined,
        accumulation: fact.accumulation,
        accountingBasis: fact.accountingBasis,
        consolidationScope: fact.consolidationScope,
        derivationKind: fact.derivationKind,
      });
    }
    return [...groups.values()].sort(
      (a, b) => b.availablePeriods - a.availablePeriods || a.label.localeCompare(b.label),
    );
  }

  async series(
    stockId: string,
    metricCode: string,
    requestedPeriods: number,
    fingerprint?: string,
  ): Promise<EarningsTrendSeriesDto> {
    await this.assertEnabledStock(stockId);
    const periods = [4, 8, 12].includes(requestedPeriods) ? requestedPeriods : 8;
    const rows = (await this.loadFacts(stockId))
      .filter((row) => row.metricCode === metricCode)
      .sort((a, b) => b.periodEndOn.localeCompare(a.periodEndOn));
    const availableFingerprints = new Set(rows.map(factCompatibilityFingerprint));
    if (fingerprint && !availableFingerprints.has(fingerprint)) {
      throw new BadRequestException('fingerprint must come from the trend options endpoint');
    }
    const selectedFingerprint = fingerprint ?? (rows[0] ? factCompatibilityFingerprint(rows[0]) : '');
    const allCompatible = rows.filter(
      (row) => factCompatibilityFingerprint(row) === selectedFingerprint,
    );
    const selected = allCompatible.slice(0, periods).reverse();
    const points = selected.map((row) => {
      const value = trendValue(row);
      const yoyBase = allCompatible.find((candidate) => sameFiscalSlot(candidate, row, -1));
      const qoqBase = row.accumulation === 'discrete'
        ? allCompatible.find((candidate) => previousFiscalQuarter(candidate, row))
        : undefined;
      return {
        eventId: row.eventId,
        revisionId: row.revisionId,
        periodEndOn: row.periodEndOn,
        periodType: displayPeriodType(row),
        fiscalYear: row.event.fiscalYear,
        fiscalQuarter: projectionQuarter(row) ?? undefined,
        periodStartOn: row.periodStartOn,
        value,
        yoy: yoyBase ? compareValues(value, trendValue(yoyBase)) : undefined,
        qoq: qoqBase ? compareValues(value, trendValue(qoqBase)) : undefined,
        reconcileStatus: row.reconcileStatus,
        derivationKind: row.derivationKind,
        inputMetricFactIds: row.inputMetricFactIds,
        sourceUrl: row.sourceUrl,
      };
    });
    const selectedIds = new Set(selected.map((row) => row.id));
    return {
      metricCode,
      label: metricLabel(metricCode),
      fingerprint: selectedFingerprint,
      points,
      omitted: rows
        .filter((row) => !selectedIds.has(row.id))
        .slice(0, 20)
        .map((row) => ({
          eventId: row.eventId,
          periodEndOn: row.periodEndOn,
          reason: factCompatibilityFingerprint(row) === selectedFingerprint
            ? 'OUTSIDE_PERIOD_LIMIT' as const
            : 'INCOMPATIBLE_SEMANTICS' as const,
        })),
    };
  }

  private async loadFacts(stockId: string): Promise<TrendFact[]> {
    const cards = await this.prisma.earningsCard.findMany({
      where: { event: { stockId }, currentRevisionId: { not: null } },
      include: { event: true, currentRevision: true },
    });
    const sourceFacts = cards.flatMap((card) => {
      const revision = card.currentRevision;
      if (!revision) return [];
      const parsed = EarningsCardPayloadSchema.safeParse(revision.payload);
      if (!parsed.success) return [];
      return parsed.data.facts.map((fact) => sourceFact({
        eventId: card.eventId,
        revisionId: revision.id,
        event: card.event,
        payload: parsed.data,
        fact,
      }));
    });
    return [...sourceFacts, ...deriveDiscreteQuarterFacts(sourceFacts)];
  }

  private async assertEnabledStock(stockId: string): Promise<void> {
    if (this.config.get<string>('EARNINGS_CROSS_PERIOD_ENABLED')?.toLowerCase() !== 'true') {
      throw new NotFoundException('Earnings trends are disabled');
    }
    const exists = await this.prisma.stock.findUnique({ where: { id: stockId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Stock not found');
  }
}

export function factCompatibilityFingerprint(fact: FingerprintFact): string {
  return createHash('sha256')
    .update([
      fact.metricCode,
      fact.valueKind,
      fact.unit,
      fact.currency ?? '',
      fact.periodKind,
      fact.accumulation,
      fact.accountingBasis,
      fact.consolidationScope,
      fact.derivationKind,
    ].join('|'))
    .digest('hex')
    .slice(0, 20);
}

function sourceFact(input: {
  eventId: string;
  revisionId: string;
  event: { fiscalYear: number; fiscalQuarter: number | null; periodType: string };
  payload: EarningsCardPayload;
  fact: MetricFact;
}): TrendFact {
  const value = input.fact.normalizedValue ?? input.fact.value;
  return {
    id: `${input.revisionId}:${input.fact.id}`,
    revisionId: input.revisionId,
    eventId: input.eventId,
    metricFactId: input.fact.id,
    metricCode: input.fact.metricCode,
    valueKind: value.kind === 'scalar' ? 'SCALAR' : 'RANGE',
    scalarValue: value.kind === 'scalar' ? new Prisma.Decimal(value.value) : null,
    rangeMin: value.kind === 'range' ? new Prisma.Decimal(value.min) : null,
    rangeMax: value.kind === 'range' ? new Prisma.Decimal(value.max) : null,
    unit: input.fact.unit,
    currency: input.fact.currency ?? null,
    periodStartOn: input.fact.periodStartOn,
    periodEndOn: input.fact.periodEndOn,
    periodKind: input.fact.periodKind,
    accumulation: input.fact.accumulation,
    accountingBasis: input.fact.accountingBasis,
    consolidationScope: input.fact.consolidationScope,
    reconcileStatus: input.fact.reconcileStatus.status,
    derivationKind: 'SOURCE',
    inputMetricFactIds: input.fact.derivation.kind === 'computed'
      ? input.fact.derivation.inputFactIds
      : [],
    sourceUrl: sourceUrlFor(input.payload, input.fact),
    event: input.event,
  };
}

function deriveDiscreteQuarterFacts(sources: TrendFact[]): TrendFact[] {
  const derived: TrendFact[] = [];
  for (const current of sources) {
    const quarter = projectionQuarter(current);
    if (!quarter || quarter < 2 || current.scalarValue === null) continue;
    if (quarter === 4 ? current.accumulation !== 'FY' : current.accumulation !== 'YTD') continue;
    const previous = sources.find((candidate) =>
      candidate.event.fiscalYear === current.event.fiscalYear
      && projectionQuarter(candidate) === quarter - 1
      && candidate.metricCode === current.metricCode
      && candidate.scalarValue !== null
      && compatibleForDifference(current, candidate)
      && (quarter === 2
        ? ['YTD', 'discrete'].includes(candidate.accumulation)
        : candidate.accumulation === 'YTD'),
    );
    if (!previous?.scalarValue) continue;
    const inputMetricFactIds = [current.metricFactId, previous.metricFactId];
    const id = createHash('sha256')
      .update(`${current.eventId}|Q${quarter}|${inputMetricFactIds.join('|')}`)
      .digest('hex');
    derived.push({
      ...current,
      id,
      metricFactId: id,
      scalarValue: current.scalarValue.minus(previous.scalarValue),
      periodStartOn: dayAfter(previous.periodEndOn),
      accumulation: 'discrete',
      reconcileStatus: 'not_applicable',
      derivationKind: 'YTD_DIFFERENCE',
      inputMetricFactIds,
    });
  }
  return derived;
}

function compatibleForDifference(current: TrendFact, previous: TrendFact): boolean {
  return current.valueKind === previous.valueKind
    && current.unit === previous.unit
    && current.currency === previous.currency
    && current.periodKind === previous.periodKind
    && current.accountingBasis === previous.accountingBasis
    && current.consolidationScope === previous.consolidationScope;
}

function sourceUrlFor(payload: EarningsCardPayload, fact: MetricFact): string | undefined {
  if (fact.provenance.kind === 'structuredSource') return fact.provenance.sourceUrl;
  const filingId = fact.provenance.filingId;
  return [payload.filing, ...payload.supportingFilings]
    .find((filing) => filing.filingId === filingId)
    ?.sourceUrl ?? payload.filing.sourceUrl;
}

function trendValue(row: TrendFact): EarningsMetricValueDto {
  if (row.valueKind === 'RANGE' && row.rangeMin && row.rangeMax) {
    return { kind: 'range', min: row.rangeMin.toString(), max: row.rangeMax.toString() };
  }
  return { kind: 'scalar', value: row.scalarValue?.toString() ?? '0' };
}

function compareValues(current: EarningsMetricValueDto, previous: EarningsMetricValueDto) {
  if (current.kind !== 'scalar' || previous.kind !== 'scalar') return undefined;
  const currentValue = new Prisma.Decimal(current.value);
  const previousValue = new Prisma.Decimal(previous.value);
  const absoluteDelta = currentValue.minus(previousValue);
  if (previousValue.isZero() || currentValue.isPositive() !== previousValue.isPositive()) {
    return { absoluteDelta: absoluteDelta.toString() };
  }
  return {
    absoluteDelta: absoluteDelta.toString(),
    percentDelta: absoluteDelta.div(previousValue.abs()).mul(100).toDecimalPlaces(2).toString(),
  };
}

function sameFiscalSlot(candidate: TrendFact, current: TrendFact, yearOffset: number): boolean {
  return candidate.event.fiscalYear === current.event.fiscalYear + yearOffset
    && projectionQuarter(candidate) === projectionQuarter(current)
    && displayPeriodType(candidate) === displayPeriodType(current);
}

function previousFiscalQuarter(candidate: TrendFact, current: TrendFact): boolean {
  const quarter = projectionQuarter(current);
  const candidateQuarter = projectionQuarter(candidate);
  if (!quarter || !candidateQuarter) return false;
  return quarter === 1
    ? candidate.event.fiscalYear === current.event.fiscalYear - 1 && candidateQuarter === 4
    : candidate.event.fiscalYear === current.event.fiscalYear && candidateQuarter === quarter - 1;
}

function projectionQuarter(row: TrendFact): number | null {
  if (row.derivationKind === 'YTD_DIFFERENCE') {
    if (row.event.periodType === 'H1' || row.event.periodType === 'Q2') return 2;
    if (row.event.periodType === 'Q3') return 3;
    if (row.event.periodType === 'FY') return 4;
  }
  if (row.event.fiscalQuarter) return row.event.fiscalQuarter;
  if (row.event.periodType === 'Q1') return 1;
  if (row.event.periodType === 'H1' || row.event.periodType === 'Q2') return 2;
  if (row.event.periodType === 'Q3') return 3;
  if (row.event.periodType === 'FY') return 4;
  return null;
}

function displayPeriodType(row: TrendFact): string {
  if (row.derivationKind !== 'YTD_DIFFERENCE') return row.event.periodType;
  if (row.event.periodType === 'H1') return 'Q2';
  if (row.event.periodType === 'FY') return 'Q4';
  return row.event.periodType;
}

function dayAfter(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function metricLabel(metricCode: string): string {
  const labels: Record<string, string> = {
    revenue: '营业收入',
    grossProfit: '毛利润',
    operatingIncome: '营业利润',
    netIncome: '净利润',
    netIncomeAttrib: '归母净利润',
    epsBasic: '基本每股收益',
    epsDiluted: '稀释每股收益',
    grossMargin: '毛利率',
    operatingMargin: '营业利润率',
    netMargin: '净利率',
    operatingCashFlow: '经营现金流',
    freeCashFlow: '自由现金流',
    totalAssets: '总资产',
    cashAndCashEquivalents: '现金及等价物',
  };
  return labels[metricCode] ?? metricCode;
}
