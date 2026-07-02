import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AgentProvider,
  BriefPayload,
  type IndexQuoteBrief,
  type WatchlistItemBrief,
  computeTechnicalIndicators,
  fetchIndexHistory,
  fetchIndexQuote,
  INDEX_SYMBOLS,
} from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';
import { SnapshotV2Service } from '../analysis/snapshot-v2.service';
import { ProviderFactoryService } from '../analysis/provider-factory.service';
import { AiSettingsService } from '../ai-settings/ai-settings.service';
import type { StockSnapshot } from '@bourse/analysis';

/**
 * Daily Brief · Brief Generator（docs/prd-daily-brief.md §7 DB.5）。
 *
 * 输入 (userId, market, session) → 输出 BriefPayload（内存对象，**不落库**）。
 * 完整简报只在 IM（v1.4）；落库由 task6/7 的推送 + 订阅模块负责。
 *
 * 两段式：
 *  ① Market Overview（per-market 共享）：INDEX_SYMBOLS 指数 quote + history →
 *     computeTechnicalIndicators → IndexQuoteBrief；AI 大盘解读 1 次/市场。
 *  ② Your Watchlist（per-user）：自选股 fetchSnapshot → compute 数字 + 上次
 *     Analysis 漂移 + 信号校验 + events；AI 自选聚合 1 次/用户；异动票深入。
 *
 * 守核心不变式：
 *  - #1 代码计算，LLM 判断：所有数字由 compute/connector 产出，prompt 注入结果
 *    让 LLM 解读，prompt 明确禁止重新推导任何数字。
 *  - #2 fetch 一次：每只票一次 fetchSnapshot。
 *  - #4 Schema-first：返回前 BriefPayload.parse 兜底。
 *
 * Provider（D12）：用用户默认 AiProviderSetting 的 utilityModel（provider.complete
 * 自动走 utilityModel 档）；用户未配 provider → 降级纯数字（interpretation=null、
 * deepDive=null），BriefPayload 数字段仍齐全照常返回。
 */
@Injectable()
export class DigestGeneratorService {
  private readonly logger = new Logger(DigestGeneratorService.name);
  private readonly index: IndexLayer;
  private readonly computeTech: typeof computeTechnicalIndicators;

  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshotV2: SnapshotV2Service,
    private readonly providerFactory: ProviderFactoryService,
    private readonly aiSettings: AiSettingsService,
    private readonly config: ConfigService,
    /**
     * 指数数据层 + 技术指标计算钩子，仅用于单测注入 stub；生产环境留空走
     * `@bourse/analysis` 默认实现（fetchIndexQuote / fetchIndexHistory /
     * computeTechnicalIndicators）。@Optional() 让真实 Nest DI 不注入（生产
     * 不传），单测直接 new 时手动传。与 stream-comprehensive-adapter 的
     * `_streamFactory` 同款 test hook 风格。
     */
    @Optional() deps?: {
      index?: IndexLayer;
      computeTech?: typeof computeTechnicalIndicators;
    },
  ) {
    this.index = deps?.index ?? {
      quote: fetchIndexQuote,
      history: fetchIndexHistory,
    };
    this.computeTech = deps?.computeTech ?? computeTechnicalIndicators;
  }

  /**
   * 生成一份 BriefPayload。内存对象，不落库。fail-soft：单指数/单票失败跳过，
   * 不阻塞整段。
   */
  async generate(
    userId: string,
    market: 'US' | 'CN' | 'HK',
    session: 'PRE' | 'POST',
  ): Promise<BriefPayload> {
    const runtime = await this.aiSettings.getDefaultRuntime(userId);
    const provider = runtime
      ? this.providerFactory.buildFromRuntime(runtime)
      : null;

    const now = new Date();
    const marketOverview = await this.buildMarketOverview(market, provider);
    const watchlist = await this.buildWatchlist(
      userId,
      market,
      session,
      provider,
      now,
    );

    // 取所有指数里最新的 dataAsOf（provenance，不变式 #5）；全失败时回退 now。
    const dataAsOf =
      [...marketOverview.timestamp].sort().at(-1) ?? now.toISOString();

    const payload = {
      market,
      session,
      generatedAt: now.toISOString(),
      dataAsOf,
      marketOverview: {
        indices: marketOverview.briefs,
        interpretation: marketOverview.interpretation,
      },
      watchlist,
    };

    // 不变式 #4：zod 兜底。失败说明上游组装出错，抛出暴露 bug（不静默吞）。
    return BriefPayload.parse(payload);
  }

  // ===========================================================================
  // ① Market Overview
  // ===========================================================================

  private async buildMarketOverview(
    market: 'US' | 'CN' | 'HK',
    provider: AgentProvider | null,
  ): Promise<{
    briefs: IndexQuoteBrief[];
    interpretation: string | null;
    /** ISO timestamp per index（brief schema 不带，留这给 dataAsOf 用）。 */
    timestamp: string[];
  }> {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - 366); // ≥1 年，满足 SMA200

    const briefs: IndexQuoteBrief[] = [];
    const timestamps: string[] = [];
    for (const symbol of INDEX_SYMBOLS[market]) {
      try {
        const quote = await this.index.quote(symbol);
        const history = await this.index.history(
          symbol,
          from.toISOString(),
          today.toISOString(),
        );
        if (!quote) continue;

        // compute 技术位（不变式 #1）：指数 bars 喂同一套算法。
        const tech =
          history && history.length > 0
            ? this.computeTech({ bars: history }).indicators
            : null;

        const lastClose = tech?.lastClose ?? quote.price;
        briefs.push({
          symbol: quote.symbol,
          name: quote.name,
          changePct: quote.changePct,
          vsSma50:
            tech?.sma50 != null && lastClose != null
              ? ((lastClose - tech.sma50) / tech.sma50) * 100
              : null,
          rsi14: tech?.rsi14 ?? null,
        });
        timestamps.push(quote.timestamp);
      } catch (err) {
        // fail-soft（DB.4）：单个指数失败跳过，不阻塞其它。
        this.logger.warn(
          `index ${symbol} failed: ${err instanceof Error ? err.message : String(err)} — skipped`,
        );
      }
    }

    // 大盘解读：把所有指数 compute 数字喂 LLM（守 #1），未配 provider 则降级 null。
    const interpretation =
      provider && briefs.length > 0
        ? await this.interpretMarket(provider, briefs).catch((err) => {
            this.logger.warn(
              `market interpretation failed: ${err instanceof Error ? err.message : String(err)} — degrading to null`,
            );
            return null;
          })
        : null;

    return { briefs, interpretation, timestamp: timestamps };
  }

  private async interpretMarket(
    provider: AgentProvider,
    indices: IndexQuoteBrief[],
  ): Promise<string | null> {
    // 不变式 #1：prompt 注入 compute 结果，明确禁止重新推导数字。
    const system =
      '你是 Bourse 的市场简报分析师。下面的大盘指数数字均由系统已计算好（涨跌幅 / 距 SMA50 百分比 / RSI14），' +
      '你的任务仅是基于这些既成数字给出一句大盘判断（风险 / 趋势 / 结构）。' +
      '禁止重新计算或推导任何数字，只解读；用一段不超过 80 字的中文。';
    const user =
      '今日大盘指数（数字已计算，直接引用，勿重算）：\n' +
      indices
        .map(
          (i) =>
            `- ${i.name}(${i.symbol})：涨跌 ${fmtPct(i.changePct)}；距 SMA50 ${fmtPct(i.vsSma50)}；RSI14 ${fmtNum(i.rsi14)}`,
        )
        .join('\n');
    const res = await provider.complete(system, user);
    const text = res.text.trim();
    return text || null;
  }

  // ===========================================================================
  // ② Your Watchlist
  // ===========================================================================

  private async buildWatchlist(
    userId: string,
    market: 'US' | 'CN' | 'HK',
    session: 'PRE' | 'POST',
    provider: AgentProvider | null,
    now: Date,
  ): Promise<BriefPayload['watchlist']> {
    const rows = await this.prisma.watchlistItem.findMany({
      where: { userId, stock: { market } },
      include: { stock: true },
      orderBy: { order: 'asc' },
    });

    // 空自选（DB.2 边界）：返回空 items 段，不阻塞大盘段。
    if (rows.length === 0) {
      return {
        items: [],
        sectorAttribution: [],
        interpretation: null,
        reanalyzeHints: [],
      };
    }

    const thresholds = this.anomalyThresholds();

    // 并发 fetch 每只票（每只一次 fetchSnapshot，守 #2）+ 取最近一次 Analysis。
    // CN Eastmoney kline 实测偶有 >8s 响应（fetchSnapshot 默认 perConnectorTimeout
    // 就是 8s），会 timeout 掉 history → drift 算不出。这里放宽到 15s 覆盖 CN 慢源；
    // 单票失败仍 fail-soft 跳过（不阻塞其它）。
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const snapshot = await this.snapshotV2
          .fetch(row.stock.symbol, market, { perConnectorTimeoutMs: 15_000 })
          .catch((err) => {
            this.logger.warn(
              `watchlist ${row.stock.symbol} fetch failed: ${err instanceof Error ? err.message : String(err)} — skipped`,
            );
            return null;
          });
        const lastAnalysis = await this.prisma.analysis.findFirst({
          where: { userId, stockId: row.stockId },
          orderBy: { createdAt: 'desc' },
        });
        return { row, snapshot, lastAnalysis };
      }),
    );

    const itemBriefs: WatchlistItemBrief[] = [];
    const sectorByItem: Map<WatchlistItemBrief, string> = new Map();
    const anomalyContext: AnomalyContext[] = [];
    for (const { row, snapshot, lastAnalysis } of enriched) {
      if (!snapshot) continue; // fetch 失败 → 跳过该票
      const item = this.assembleItemBrief(snapshot, lastAnalysis, now);
      if (!item) continue;
      itemBriefs.push(item);
      // Stock.sector：connector 首次入库时填（schema 注释）；缺失归 '未分类'。
      sectorByItem.set(item, row.stock.sector?.trim() || '未分类');

      const ctx = this.buildAnomalyContext(
        item,
        lastAnalysis,
        now,
        thresholds,
      );
      if (ctx) anomalyContext.push(ctx);
    }

    // 板块归因（POST 专属，DB.2）：Stock.sector + 同板块均涨跌。
    const sectorAttribution =
      session === 'POST' ? this.computeSectorAttribution(sectorByItem) : [];

    // 异动深入（DB.5 ③）：top 3，仅命中触发；未配 provider 则全部降级 null。
    const deepDiveMap =
      provider && anomalyContext.length > 0
        ? await this.runDeepDives(provider, anomalyContext.slice(0, 3))
        : new Map<string, string | null>();

    // 把 deepDive 回填到命中票。
    for (const item of itemBriefs) {
      if (deepDiveMap.has(item.symbol) && deepDiveMap.get(item.symbol)) {
        item.deepDive = deepDiveMap.get(item.symbol)!;
      }
    }

    // 自选聚合解读（1 次/用户）：把自选数字 + 板块归因喂 LLM。
    const interpretation =
      provider && itemBriefs.length > 0
        ? await this.interpretWatchlist(
            provider,
            itemBriefs,
            sectorAttribution,
          ).catch((err) => {
            this.logger.warn(
              `watchlist interpretation failed: ${err instanceof Error ? err.message : String(err)} — degrading to null`,
            );
            return null;
          })
        : null;

    // 复研建议（DB.7，POST）：距上次 >阈值 且异动 → 提示复研。
    const reanalyzeHints =
      session === 'POST'
        ? anomalyContext
            .filter((c) => c.reasons.includes('stale'))
            .map((c) => ({
              symbol: c.symbol,
              reason: '距上次分析超过 30 天且出现异动，建议复研',
            }))
        : [];

    return {
      items: itemBriefs,
      sectorAttribution,
      interpretation,
      reanalyzeHints,
    };
  }

  /**
   * 单只票 → WatchlistItemBrief。compute 数字来自 snapshot（fetchSnapshot 内部已
   * 跑过 computeTechnicalIndicators，不重复计算）。driftSinceLastAnalysis：
   *   - 无历史 Analysis → null
   *   - 有 Analysis.dataAsOf 但在 history 里找不到对应日收盘 → null（无法校准）
   *   - 否则 → (现价 - dataAsOf 收盘) / dataAsOf 收盘 × 100
   */
  private assembleItemBrief(
    snapshot: StockSnapshot,
    lastAnalysis: { dataAsOf: string | null } | null,
    now: Date,
  ): WatchlistItemBrief | null {
    const quote = snapshot.rawFacts.quote;
    if (!quote || !Number.isFinite(quote.price)) return null;

    const tech = snapshot.computedFacts.technicalIndicators;
    const changePct = quote.changePct ?? 0;
    const lastClose = tech?.lastClose ?? quote.price;

    const drift = this.computeDrift(snapshot, lastAnalysis);
    const events = this.extractEvents(snapshot, now);

    return {
      symbol: snapshot.symbol,
      changePct,
      driftSinceLastAnalysis: drift,
      rsi14: tech?.rsi14 ?? null,
      vsSma50:
        tech?.sma50 != null && lastClose != null
          ? ((lastClose - tech.sma50) / tech.sma50) * 100
          : null,
      vsSma200:
        tech?.sma200 != null && lastClose != null
          ? ((lastClose - tech.sma200) / tech.sma200) * 100
          : null,
      events,
      deepDive: null, // 异动触发后回填
    };
  }

  /** 距上次分析漂移 %。无历史 Analysis 或无法校准 → null。 */
  private computeDrift(
    snapshot: StockSnapshot,
    lastAnalysis: { dataAsOf: string | null } | null,
  ): number | null {
    const dataAsOf = lastAnalysis?.dataAsOf;
    if (!dataAsOf) return null; // 无历史 Analysis（DB.2 边界）
    const quote = snapshot.rawFacts.quote;
    const history = snapshot.rawFacts.history;
    if (!quote || !Number.isFinite(quote.price) || !history || history.length === 0) {
      return null;
    }
    // dataAsOf 是日期串（如 "2026-05-21"），按日期前缀匹配最近一根收盘。
    const day = dataAsOf.slice(0, 10);
    const bar = [...history]
      .reverse()
      .find((b) => b.timestamp.slice(0, 10) <= day);
    if (!bar) return null; // dataAsOf 早于历史窗口起点 → 无法校准
    const ref = bar.adjustedClose ?? bar.close;
    if (!ref || ref === 0) return null;
    return ((quote.price - ref) / ref) * 100;
  }

  /**
   * 今日事件（财报/解禁）。snapshot 不含 news 字段；从 unlockCalendar（CN）派生。
   * 非 CN 或无解禁数据 → 空数组（Phase A 不强依赖 news，YAGNI）。
   */
  private extractEvents(
    snapshot: StockSnapshot,
    now: Date,
  ): { kind: string; date: string }[] {
    const uc = snapshot.rawFacts.unlockCalendar;
    if (!uc || typeof uc !== 'object') return [];
    const events = (uc as { events?: unknown }).events;
    if (!Array.isArray(events)) return [];
    // 当日/次日窗口（PRD DB.5 line 301「撞财报 = 当日/次日」）。此前 `day >= today`
    // 会把未来所有解禁都收进来，修正为 [today, +1d]。
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now.getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const out: { kind: string; date: string }[] = [];
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      const date = (e as { date?: unknown }).date;
      const shares = (e as { shares?: unknown }).shares;
      if (typeof date !== 'string' || typeof shares !== 'number' || shares <= 0) {
        continue;
      }
      const day = date.slice(0, 10);
      if (day >= today && day <= tomorrow) {
        out.push({ kind: 'UNLOCK', date: day });
      }
    }
    return out;
  }

  /**
   * 板块归因（POST 专属，DB.2）：按 Stock.sector 分组取同板块均涨跌。
   * sector 来自 watchlist 查询（Stock.sector，connector 首次入库时填）。
   * 真「板块轮动 / 宽度」属 Phase C backlog（PRD §9）；本期仅做同板块均涨跌。
   */
  private computeSectorAttribution(
    sectorByItem: Map<WatchlistItemBrief, string>,
  ): BriefPayload['watchlist']['sectorAttribution'] {
    if (sectorByItem.size === 0) return [];
    const groups = new Map<string, { sum: number; n: number }>();
    for (const [item, sector] of sectorByItem) {
      const g = groups.get(sector) ?? { sum: 0, n: 0 };
      g.sum += item.changePct;
      g.n += 1;
      groups.set(sector, g);
    }
    return [...groups.entries()]
      .map(([sector, g]) => ({ sector, changePct: g.sum / g.n }))
      .sort((a, b) => b.changePct - a.changePct);
  }

  // ===========================================================================
  // 异动触发（DB.5 ③）
  // ===========================================================================

  /** 从 env 读异动阈值（全局，非 per-user），缺失用 DB.5 初值。 */
  private anomalyThresholds(): AnomalyThresholds {
    const num = (key: string, fallback: number) => {
      const v = this.config.get<string>(key);
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      changePct: num('DIGEST_ANOMALY_CHANGE_PCT', 3),
      rsiOverbought: num('DIGEST_ANOMALY_RSI_OVERBOUGHT', 70),
      rsiOversold: num('DIGEST_ANOMALY_RSI_OVERSOLD', 30),
      staleDays: num('DIGEST_ANOMALY_STALE_DAYS', 30),
    };
  }

  /**
   * 异动判定（PRD DB.5）。命中任一条件 → 返回带 reasons 的 context；否则 null。
   * 只存 deepDive 真正消费的字段（symbol / item / reasons），不携带死字段。
   *
   * 触发条件（全局 env 阈值，初值见 DB.5）：
   *   - 单日涨跌 |changePct| ≥ 阈值
   *   - RSI 超买 / 超卖
   *   - 技术破位（收盘低于 SMA50/200）
   *   - 撞解禁（events 已收当日/次日）
   *   - 距上次分析过期（now − lastAnalysis.createdAt > staleDays）
   *
   * 「信号翻转」（DB.5 line 300）需要当前信号与上次 overallSignal 比对，但本
   * brief 只出 compute 数字、不做信号评估，无当前信号可比——该条件本期不实现
   * （留复研/再分析流程产出新 overallSignal 后才能比对）。
   */
  private buildAnomalyContext(
    item: WatchlistItemBrief,
    lastAnalysis: { createdAt: Date } | null,
    now: Date,
    thresholds: AnomalyThresholds,
  ): AnomalyContext | null {
    const reasons: string[] = [];
    if (Math.abs(item.changePct) >= thresholds.changePct) reasons.push('big_move');
    if (item.rsi14 != null) {
      if (item.rsi14 >= thresholds.rsiOverbought) reasons.push('overbought');
      if (item.rsi14 <= thresholds.rsiOversold) reasons.push('oversold');
    }
    if (item.vsSma50 != null && item.vsSma50 < 0) reasons.push('below_sma50');
    if (item.vsSma200 != null && item.vsSma200 < 0) reasons.push('below_sma200');
    if (item.events.some((e) => e.kind === 'UNLOCK')) reasons.push('unlock');
    if (lastAnalysis) {
      const ageDays =
        (now.getTime() - lastAnalysis.createdAt.getTime()) / 86_400_000;
      if (ageDays > thresholds.staleDays) reasons.push('stale');
    }
    return reasons.length > 0 ? { symbol: item.symbol, item, reasons } : null;
  }

  /**
   * 异动深入（top N）。每只命中票 1 次 provider.complete（utilityModel 档）。
   * 单票失败 → 该票 deepDive=null（不阻塞其它）。返回 symbol → deepDive 文本 map。
   */
  private async runDeepDives(
    provider: AgentProvider,
    contexts: AnomalyContext[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    await Promise.all(
      contexts.map(async (ctx) => {
        try {
          const text = await this.deepDive(provider, ctx);
          out.set(ctx.symbol, text);
        } catch (err) {
          this.logger.warn(
            `deepDive ${ctx.symbol} failed: ${err instanceof Error ? err.message : String(err)} — null`,
          );
          out.set(ctx.symbol, null);
        }
      }),
    );
    return out;
  }

  private async deepDive(
    provider: AgentProvider,
    ctx: AnomalyContext,
  ): Promise<string | null> {
    const i = ctx.item;
    // 不变式 #1：注入 compute 数字，禁止重算。
    const system =
      '你是 Bourse 的个股异动分析师。下面的数字（涨跌 / RSI / 距均线 / 距上次分析漂移）均由系统已计算好，' +
      '你的任务仅是基于这些既成数字解读异动归因并给出是否需要复研的建议。' +
      '禁止重新计算或推导任何数字，只解读；用一段不超过 120 字的中文。';
    // 把内部 reason 代号转中文标签喂 prompt（避免 LLM 把 'below_sma50' 等
    // 英文代号照抄进中文解读，IM 卡片里看着不自然）。
    const reasonsTxt =
      ctx.reasons.map((r) => ANOMALY_REASON_LABEL[r] ?? r).join('、') ||
      '无明显触发';
    const user =
      `个股 ${i.symbol} 触发异动（${reasonsTxt}）。数字已计算，直接引用，勿重算：\n` +
      `- 今日涨跌：${fmtPct(i.changePct)}\n` +
      `- RSI14：${fmtNum(i.rsi14)}；距 SMA50 ${fmtPct(i.vsSma50)}；距 SMA200 ${fmtPct(i.vsSma200)}\n` +
      `- 距上次分析漂移：${fmtPct(i.driftSinceLastAnalysis)}\n` +
      `- 今日事件：${i.events.map((e) => `${e.kind}@${e.date}`).join('、') || '无'}`;
    const res = await provider.complete(system, user);
    const text = res.text.trim();
    return text || null;
  }

  private async interpretWatchlist(
    provider: AgentProvider,
    items: WatchlistItemBrief[],
    sectorAttribution: BriefPayload['watchlist']['sectorAttribution'],
  ): Promise<string | null> {
    // 不变式 #1：注入 compute 数字。
    const system =
      '你是 Bourse 的自选股组合简报分析师。下面的数字均由系统已计算好，你的任务仅是基于这些既成数字给出一' +
      '段自选聚合解读（整体强弱 / 共性 / 关注点）。禁止重新计算或推导任何数字，只解读；用一段不超过 120 字的中文。' +
      '可在解读里点名全部自选的概况（非异动票折叠展示，解读仍覆盖）。';
    const user =
      '今日自选（数字已计算，直接引用，勿重算）：\n' +
      items
        .map(
          (i) =>
            `- ${i.symbol}：涨跌 ${fmtPct(i.changePct)}；RSI14 ${fmtNum(i.rsi14)}；距 SMA50 ${fmtPct(i.vsSma50)}；距上次分析 ${fmtPct(i.driftSinceLastAnalysis)}`,
        )
        .join('\n') +
      (sectorAttribution.length > 0
        ? '\n板块归因：\n' +
          sectorAttribution.map((s) => `- ${s.sector}：${fmtPct(s.changePct)}`).join('\n')
        : '');
    const res = await provider.complete(system, user);
    const text = res.text.trim();
    return text || null;
  }
}

// ============================================================================
// 内部类型
// ============================================================================

/** 指数数据层（test hook 注入用；生产走 @bourse/analysis 默认实现）。 */
interface IndexLayer {
  quote: typeof fetchIndexQuote;
  history: typeof fetchIndexHistory;
}

interface AnomalyThresholds {
  changePct: number;
  rsiOverbought: number;
  rsiOversold: number;
  staleDays: number;
}

interface AnomalyContext {
  symbol: string;
  item: WatchlistItemBrief;
  reasons: string[];
}

// ============================================================================
// 异动 reason 代号 → 中文标签（喂 prompt 用，避免英文代号泄漏进 AI 解读）
// ============================================================================

const ANOMALY_REASON_LABEL: Record<string, string> = {
  big_move: '单日大涨跌',
  overbought: 'RSI 超买',
  oversold: 'RSI 超卖',
  below_sma50: '跌破 50 日线',
  below_sma200: '跌破 200 日线',
  unlock: '撞解禁',
  stale: '距上次分析过期',
};

// ============================================================================
// 数字格式化（注入 prompt 用；compute 已产出数字，这里只做人类可读串）
// ============================================================================

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'N/A';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'N/A';
  return v.toFixed(2);
}
