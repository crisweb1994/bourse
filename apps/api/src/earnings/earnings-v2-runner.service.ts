import { Injectable } from '@nestjs/common';
import {
  createEastmoneyHkV2FinancialsConnector,
  createEastmoneyV2FinancialsConnector,
  createSecEdgarXbrlV2FinancialsConnector,
  type FetchLike,
  type FinancialsBundleV2,
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
  source: 'source' | 'title_rule' | 'narrative_hint' | 'provider_period' | 'missing';
  diagnostics: string[];
}

export type StructuredProviderResult = Awaited<
  ReturnType<ProviderFinancialsV2Port['fetchFinancials']>
>;

/**
 * 事件身份权威关系（§10）：官方 filing metadata（source）> 确定性标题/日期规则 >
 * LLM hint（只能触发复核，不能单独创建 numeric card——identity 来源为
 * narrative_hint 时仍允许运行，但 diagnostics 会记录由 LLM 提供）。
 */
export function resolveV2Identity(
  source: { expectedPeriodEndOn?: string; periodType?: string; fiscalYear?: number },
  narrativeHints?: { periodEndOn?: string; periodType?: string },
  filing?: { formType?: string; title?: string | null },
): V2IdentityResolution {
  const fromTitle = identityFromFilingMetadata(filing);
  const sourcePeriodType = isExpectedPeriodType(source.periodType)
    ? source.periodType
    : fromTitle.identity?.periodType ?? periodTypeFromFilingMetadata(filing, source.expectedPeriodEndOn);
  if (source.expectedPeriodEndOn && sourcePeriodType) {
    return {
      identity: {
        periodEndOn: source.expectedPeriodEndOn,
        periodType: sourcePeriodType,
        fiscalYear: source.fiscalYear ?? Number(source.expectedPeriodEndOn.slice(0, 4)),
      },
      source: 'source',
      diagnostics: [],
    };
  }
  if (fromTitle.identity) {
    return {
      identity: fromTitle.identity,
      source: 'title_rule',
      diagnostics: fromTitle.diagnostics,
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
    diagnostics: ['no period identity available from filing metadata, title rules, or narrative hints'],
  };
}

/**
 * Provider-first 的最后一小步：当公告没有可用日期（港交所标题经常如此）
 * 时，用 Provider 自己返回的 periods 补齐事件身份。Provider 只负责返回
 * period 元数据，核心事实仍然由后续的 selector 精确选取。
 */
export function resolveV2IdentityWithProviderPeriods(
  source: { expectedPeriodEndOn?: string; periodType?: string; fiscalYear?: number },
  narrativeHints: { periodEndOn?: string; periodType?: string } | undefined,
  filing: { formType?: string; title?: string | null } | undefined,
  periods: ReadonlyArray<Pick<FinancialsBundleV2['periods'][number], 'id' | 'fiscalYear' | 'fiscalPeriodType' | 'periodEndOn'>>,
): V2IdentityResolution {
  const resolved = resolveV2Identity(source, narrativeHints, filing);
  if (periods.length === 0) return resolved;
  if (resolved.identity) return alignIdentityToProviderPeriod(resolved, periods);

  const expectedType = isExpectedPeriodType(source.periodType)
    ? source.periodType
    : periodTypeFromFilingMetadata(filing, source.expectedPeriodEndOn);
  const titleYear = fiscalYearFromTitle(filing?.title);
  const expectedFiscalYear = source.fiscalYear ?? titleYear;
  let candidates = periods.filter((period) => period.fiscalPeriodType !== 'TTM');

  if (source.expectedPeriodEndOn) {
    candidates = candidates.filter((period) => period.periodEndOn === source.expectedPeriodEndOn);
  }
  if (expectedType) {
    const typed = candidates.filter((period) => period.fiscalPeriodType === expectedType);
    if (typed.length > 0) candidates = typed;
  }
  if (expectedFiscalYear !== undefined) {
    const yearMatched = candidates.filter(
      (period) => period.fiscalYear === expectedFiscalYear || period.periodEndOn.startsWith(`${expectedFiscalYear}-`),
    );
    if (yearMatched.length > 0) candidates = yearMatched;
  }

  const candidate = [...candidates].sort((a, b) => (a.periodEndOn < b.periodEndOn ? 1 : -1))[0];
  if (!candidate) {
    return {
      ...resolved,
      diagnostics: [
        ...resolved.diagnostics,
        'provider returned periods but none could be associated with the filing identity',
      ],
    };
  }

  return {
    identity: {
      periodEndOn: candidate.periodEndOn,
      periodType: toExpectedPeriodType(candidate.fiscalPeriodType),
      // Provider 的 fiscalYear 允许使用发行人财年开始年（HK FYE 3/31
      // 就是这种语义）；EarningsEvent 的 fiscalYear 用报告期展示年份，
      // 因此优先沿用源/标题年份，最后才退回 periodEndOn 年份。
      fiscalYear: source.fiscalYear ?? titleYear ?? Number(candidate.periodEndOn.slice(0, 4)),
    },
    source: 'provider_period',
    diagnostics: [
      ...resolved.diagnostics,
      `identity resolved from provider period ${candidate.id}`,
    ],
  };
}

function alignIdentityToProviderPeriod(
  resolved: V2IdentityResolution,
  periods: ReadonlyArray<Pick<FinancialsBundleV2['periods'][number], 'id' | 'fiscalYear' | 'fiscalPeriodType' | 'periodEndOn'>>,
): V2IdentityResolution {
  if (!resolved.identity) return resolved;
  const exact = periods.filter((period) => period.periodEndOn === resolved.identity?.periodEndOn);
  if (exact.length === 0) return resolved;

  const compatible = exact.find((period) => providerPeriodMatchesExpected(resolved.identity!.periodType, period.fiscalPeriodType));
  if (compatible) return resolved;
  const providerPeriod = exact[0];
  return {
    identity: {
      periodEndOn: providerPeriod.periodEndOn,
      periodType: toExpectedPeriodType(providerPeriod.fiscalPeriodType),
      fiscalYear: resolved.identity.fiscalYear ?? Number(providerPeriod.periodEndOn.slice(0, 4)),
    },
    source: 'provider_period',
    diagnostics: [
      ...resolved.diagnostics,
      `provider period ${providerPeriod.id} corrected the filing period type for the exact end date`,
    ],
  };
}

function providerPeriodMatchesExpected(
  expected: ExpectedEarningsPeriodType,
  actual: string,
): boolean {
  if (expected === 'Q3') return actual === 'Q3' || actual === '9M';
  if (expected === 'FY') return actual === 'FY';
  return actual === expected;
}

/**
 * 确定性标题/日期规则（§10 第三优先级）。
 *
 * CN/HK：中文标题含报告期关键字（"2025年半年度报告"、"2025年第三季度报告"、
 * "2025年年度业绩快报" 等）；US：10-Q/10-K 标题含 "period ended <date>"。
 * 非自然财年无法从标题确定精确季索引/财年起点时，按自然年近似并记录诊断。
 */
export function identityFromFilingMetadata(filing?: {
  formType?: string;
  title?: string | null;
}): { identity?: V2LaneIdentity; diagnostics: string[] } {
  const title = filing?.title ?? '';
  const formType = (filing?.formType ?? '').toLowerCase();

  // HK 业绩公告标题："截至2026年 3 月 31日止三個月之業績公告" / "RESULTS
  // ANNOUNCEMENT FOR THE THREE MONTHS ENDED MARCH 31, 2026"。期间长度直接
  // 给出 quarter 类型，结束日为显式日期（支持繁体/简体/英文）。
  const cnPeriod = /截至\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*止(?:之)?(三個月|三个月|3個月|六個月|六个月|6個月|九個月|九个月|9個月|十二個月|十二个月|12個月|年度|全年)/i.exec(
    title,
  );
  if (cnPeriod) {
    const end = `${cnPeriod[1]}-${pad2(cnPeriod[2])}-${pad2(cnPeriod[3])}`;
    const length = cnPeriod[4];
    const periodType = /三/.test(length) ? 'Q1' : /六/.test(length) ? 'H1' : /九/.test(length) ? '9M' : 'FY';
    return {
      identity: { periodEndOn: end, periodType, fiscalYear: Number(cnPeriod[1]) },
      diagnostics: ['identity derived from HK results-announcement title (period length + end date)'],
    };
  }

  // 英文标题两种日期顺序都支持："MONTHS ENDED MARCH 31, 2026" 与
  // "YEAR ENDED 31 DECEMBER 2025"（日在前、月在后）。
  const enMonths = /(three|six|nine|twelve|year)(?:\s+months)?\s+ended\s+(?:([A-Z][a-z]+\.?)\s+(\d{1,2}),?\s+(20\d{2})|(\d{1,2})\s+([A-Z][a-z]+\.?)\s+(20\d{2}))/i.exec(
    title,
  );
  if (enMonths) {
    const monthName = enMonths[2] ?? enMonths[6];
    const month = MONTH_INDEX[monthName.toLowerCase().replace('.', '')];
    const day = Number(enMonths[3] ?? enMonths[5]);
    const year = Number(enMonths[4] ?? enMonths[7]);
    if (month && day >= 1 && day <= 31) {
      const end = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
      const length = enMonths[1].toLowerCase();
      const periodType = length === 'three' ? 'Q1' : length === 'six' ? 'H1' : length === 'nine' ? '9M' : 'FY';
      return {
        identity: { periodEndOn: end, periodType, fiscalYear: year },
        diagnostics: ['identity derived from HK results-announcement title (period length + end date)'],
      };
    }
  }

  // HKEX 常见标题会把财年和年末月份拆开写，例如：
  // "ANNOUNCEMENT OF THE MARCH QUARTER 2026 RESULTS AND FISCAL YEAR
  // 2026 ANNUAL RESULTS"。这里的月份来自发行人的财年，而不是自然年。
  const hkFiscalYear = /\bfiscal\s+year\s+(20\d{2})\s+annual\s+results\b/i.exec(title);
  if (hkFiscalYear) {
    const monthMatch = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+quarter\s+20\d{2}\b/i.exec(title);
    if (monthMatch) {
      const year = Number(hkFiscalYear[1]);
      const month = MONTH_INDEX[monthMatch[1].toLowerCase()];
      const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return {
        identity: {
          periodEndOn: `${year}-${pad2(String(month))}-${pad2(String(day))}`,
          periodType: 'FY',
          fiscalYear: year,
        },
        diagnostics: ['identity derived from HKEX fiscal-year annual-results title'],
      };
    }
    // 只有财年没有年末月份时，不把 12 月 31 日当成事实；交给 Provider periods。
    return { diagnostics: ['HKEX fiscal-year title has no explicit fiscal-year-end month'] };
  }

  const cnYear = /(20\d{2})\s*年?/.exec(title);
  if (cnYear) {
    const year = Number(cnYear[1]);
    const natural = ['identity derived from filing title; natural-year assumption'];
    if (/半年度|中期(?:报告|业绩|報)|interim/i.test(title)) {
      return { identity: { periodEndOn: `${year}-06-30`, periodType: 'H1', fiscalYear: year }, diagnostics: natural };
    }
    if (/第[三3]季度|三季报|三季度/.test(title)) {
      return { identity: { periodEndOn: `${year}-09-30`, periodType: '9M', fiscalYear: year }, diagnostics: natural };
    }
    if (/第[二2]季度|二季报|二季度/.test(title)) {
      return { identity: { periodEndOn: `${year}-06-30`, periodType: 'Q2', fiscalYear: year }, diagnostics: natural };
    }
    if (/第[一1]季度|一季报|一季度/.test(title)) {
      return { identity: { periodEndOn: `${year}-03-31`, periodType: 'Q1', fiscalYear: year }, diagnostics: natural };
    }
    if (/年度报告|年报|年度业绩|业绩(?:快报|预告)/.test(title)) {
      return { identity: { periodEndOn: `${year}-12-31`, periodType: 'FY', fiscalYear: year }, diagnostics: natural };
    }
  }

  const usDate = /(?:period|fiscal year|year)\s+ended\s+([A-Z][a-z]+\.?)\s+(\d{1,2}),?\s+(20\d{2})/i.exec(title);
  if (usDate) {
    const month = MONTH_INDEX[usDate[1].toLowerCase().replace('.', '')];
    const day = Number(usDate[2]);
    const year = Number(usDate[3]);
    if (month && day >= 1 && day <= 31) {
      const end = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
      if (formType === '10-k') {
        return {
          identity: { periodEndOn: end, periodType: 'FY', fiscalYear: year },
          diagnostics: ['identity derived from 10-K title period-ended date'],
        };
      }
      if (formType === '10-q') {
        const quarter = month <= 3 ? 'Q1' : month <= 6 ? 'Q2' : 'Q3';
        return {
          identity: { periodEndOn: end, periodType: quarter, fiscalYear: year },
          diagnostics: ['identity derived from 10-Q title period-ended date; quarter index uses calendar months'],
        };
      }
    }
  }

  return { diagnostics: ['no deterministic period identity in filing title'] };
}

function pad2(value: string): string {
  return value.padStart(2, '0');
}

const MONTH_INDEX: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

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

function periodTypeFromFilingMetadata(
  filing: { formType?: string; title?: string | null } | undefined,
  periodEndOn?: string,
): ExpectedEarningsPeriodType | undefined {
  const formType = (filing?.formType ?? '').toLowerCase();
  const title = filing?.title ?? '';
  if (/10-k|20-f/.test(formType) || /annual|年报|年度|fiscal\s+year/i.test(`${formType} ${title}`)) return 'FY';
  if (/semiannual|interim|中期|半年度|半年报/i.test(`${formType} ${title}`)) return 'H1';
  if (/10-q/.test(formType)) {
    return quarterFromEndDate(periodEndOn);
  }
  if (/quarterly|季度|三个月|three\s+months/i.test(`${formType} ${title}`)) {
    if (/nine|九个?月|9m|third|第三|三季/i.test(title)) return '9M';
    return 'Q1';
  }
  return undefined;
}

function quarterFromEndDate(periodEndOn?: string): ExpectedEarningsPeriodType | undefined {
  if (!periodEndOn) return undefined;
  const month = Number(periodEndOn.slice(5, 7));
  if (!Number.isFinite(month)) return undefined;
  if (month <= 3) return 'Q1';
  if (month <= 6) return 'Q2';
  if (month <= 9) return 'Q3';
  return 'FY';
}

function fiscalYearFromTitle(title?: string | null): number | undefined {
  const match = title?.match(/(?:fiscal\s+year|20\d{2}\s*年|year\s+ended)\s*[:：]?\s*(20\d{2})/i)
    ?? title?.match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function toExpectedPeriodType(value: string): ExpectedEarningsPeriodType {
  return value === 'Q1' || value === 'Q2' || value === 'Q3' || value === 'H1' || value === '9M' || value === 'FY'
    ? value
    : value === 'Q4' ? 'FY' : 'FY';
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
  providerResult?: StructuredProviderResult;
  now?: string;
}

export interface StructuredLaneResult {
  selection: StructuredEarningsSelection;
  snapshotId?: string;
}

@Injectable()
export class EarningsV2RunnerService {
  constructor(private readonly selectionService: StructuredSelectionService) {}

  async fetchProviderFinancials(input: {
    stock: { market: string; symbol: string };
    connector: ProviderFinancialsV2Port;
  }): Promise<StructuredProviderResult> {
    return input.connector.fetchFinancials({
      instrumentId: `${input.stock.market}:${input.stock.symbol}`,
      deriveTTM: false,
    });
  }

  async runStructuredLane(input: StructuredLaneInput): Promise<StructuredLaneResult> {
    const instrumentId = `${input.stock.market}:${input.stock.symbol}`;
    const result = input.providerResult ?? await this.fetchProviderFinancials(input);

    if (!result.data) {
      const selection = unsupportedSelection(
        'source_no_data',
        result.warnings.map((warning) => warning.message),
      );
      await this.selectionService.saveSelection({
        eventId: input.eventId,
        selection,
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
