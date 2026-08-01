import { Injectable } from '@nestjs/common';
import {
  createEastmoneyHkV2FinancialsConnector,
  createEastmoneyV2FinancialsConnector,
  createSecEdgarXbrlV2FinancialsConnector,
  type FetchLike,
  type ProviderFinancialsV2Port,
} from '@bourse/market-data';
import {
  projectStructuredEarnings,
  type ExpectedEarningsPeriodType,
  type StructuredEarningsSelection,
} from '@bourse/analysis';
import { StructuredSelectionService } from './structured-selection.service';

/**
 * Earnings v2 双通道 runner 核心（docs/structured-first-earnings-architecture.md §11）。
 *
 * 本轮交付：structured lane（fetch v2 bundle → 快照 → selector → selection）+
 * 事件身份解析 + 市场 connector 工厂。document lane 与 run() 编排（persist/
 * notify/scheduler 切换）在下一轮接入。
 *
 * 关键约束：不退回旧期间、不宽容匹配；pending 是可预期状态。
 */

export interface V2LaneIdentity {
  periodEndOn: string;
  periodType: ExpectedEarningsPeriodType;
  fiscalYear?: number;
}

export interface V2IdentityResolution {
  identity?: V2LaneIdentity;
  source: 'source' | 'narrative_hint' | 'missing';
  diagnostics: string[];
}

/**
 * 事件身份权威关系（§10）：官方 filing metadata（source）> 确定性规则 > LLM
 * hint（只能触发复核，不能单独创建 numeric card——identity 来源为
 * narrative_hint 时仍允许运行，但 diagnostics 会记录由 LLM 提供）。
 */
export function resolveV2Identity(
  source: { expectedPeriodEndOn?: string; periodType?: string; fiscalYear?: number },
  narrativeHints?: { periodEndOn?: string; periodType?: string },
): V2IdentityResolution {
  if (source.expectedPeriodEndOn && isExpectedPeriodType(source.periodType)) {
    return {
      identity: {
        periodEndOn: source.expectedPeriodEndOn,
        periodType: source.periodType,
        ...(source.fiscalYear !== undefined ? { fiscalYear: source.fiscalYear } : {}),
      },
      source: 'source',
      diagnostics: [],
    };
  }
  if (narrativeHints?.periodEndOn && isExpectedPeriodType(narrativeHints.periodType)) {
    return {
      identity: {
        periodEndOn: narrativeHints.periodEndOn,
        periodType: narrativeHints.periodType,
      },
      source: 'narrative_hint',
      diagnostics: [
        'identity derived from LLM eventIdentityHints; treat as diagnostic, not authoritative',
      ],
    };
  }
  return {
    source: 'missing',
    diagnostics: ['no period identity available from filing metadata or narrative hints'],
  };
}

function isExpectedPeriodType(value: string | undefined): value is ExpectedEarningsPeriodType {
  return (
    value === 'Q1' ||
    value === 'Q2' ||
    value === 'Q3' ||
    value === 'H1' ||
    value === '9M' ||
    value === 'FY'
  );
}

export interface V2ConnectorOptions {
  /** SEC User-Agent；默认使用项目确认的 bourance + bourance.gmail.com。 */
  userAgent?: string;
  fetchLike?: FetchLike;
}

/** 市场 → v2 financials connector 工厂（US/CN/HK）。 */
export function buildV2FinancialsConnector(
  market: string,
  options: V2ConnectorOptions = {},
): ProviderFinancialsV2Port | null {
  const userAgent = options.userAgent ?? 'bourance + bourance.gmail.com';
  if (market === 'US') {
    return createSecEdgarXbrlV2FinancialsConnector({
      userAgent,
      ...(options.fetchLike ? { fetchLike: options.fetchLike } : {}),
    });
  }
  if (market === 'CN') {
    return createEastmoneyV2FinancialsConnector({
      ...(options.fetchLike ? { fetchLike: options.fetchLike } : {}),
    });
  }
  if (market === 'HK') {
    return createEastmoneyHkV2FinancialsConnector({
      ...(options.fetchLike ? { fetchLike: options.fetchLike } : {}),
    });
  }
  return null;
}

export interface StructuredLaneInput {
  eventId: string;
  stock: { id: string; market: string; symbol: string };
  identity: V2LaneIdentity;
  eventPublishedAt: string;
  knowledgeCutoffAt: string;
  connector: ProviderFinancialsV2Port;
  now?: string;
}

export interface StructuredLaneResult {
  selection: StructuredEarningsSelection;
  snapshotId?: string;
}

@Injectable()
export class EarningsV2RunnerService {
  constructor(private readonly selectionService: StructuredSelectionService) {}

  async runStructuredLane(input: StructuredLaneInput): Promise<StructuredLaneResult> {
    const instrumentId = `${input.stock.market}:${input.stock.symbol}`;
    const result = await input.connector.fetchFinancials({
      instrumentId,
      deriveTTM: false,
    });

    if (!result.data) {
      const selection = unsupportedSelection(
        'source_no_data',
        result.warnings.map((warning) => warning.message),
      );
      await this.selectionService.saveSelection({
        eventId: input.eventId,
        selection,
        snapshotIds: [],
        knowledgeCutoffAt: input.knowledgeCutoffAt,
        retryAt: defaultRetryAt(input.now, input.stock.market),
      });
      return { selection };
    }

    const snapshot = await this.selectionService.saveSnapshot(input.stock.id, result.data);
    const selection = projectStructuredEarnings({
      bundle: result.data,
      market: input.stock.market as 'US' | 'CN' | 'HK',
      expectedInstrumentId: instrumentId,
      expectedPeriodEndOn: input.identity.periodEndOn,
      expectedPeriodType: input.identity.periodType,
      expectedFiscalYear: input.identity.fiscalYear,
      eventPublishedAt: input.eventPublishedAt,
      knowledgeCutoffAt: input.knowledgeCutoffAt,
      now: input.now,
    });
    await this.selectionService.saveSelection({
      eventId: input.eventId,
      selection,
      snapshotIds: [snapshot.id],
      knowledgeCutoffAt: input.knowledgeCutoffAt,
      retryAt: selection.status === 'pending' ? selection.retryAt : undefined,
    });
    return { selection, snapshotId: snapshot.id };
  }
}

function unsupportedSelection(
  reason: string,
  warnings: string[],
): StructuredEarningsSelection {
  return {
    status: 'unsupported',
    reason,
    diagnostics: {
      expected: {} as never,
      candidatePeriods: [],
      rejected: warnings.map((message) => ({ reason: message })),
      warnings,
    },
  };
}

function defaultRetryAt(now: string | undefined, market: string): string | undefined {
  if (!now) return undefined;
  const baseMs = Date.parse(now);
  if (Number.isNaN(baseMs)) return undefined;
  const intervalMs = market === 'US' ? 12 * 60 * 60 * 1000 : 30 * 60 * 1000;
  return new Date(baseMs + intervalMs).toISOString();
}
