import { Injectable, NotFoundException, Logger, OnModuleInit, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildWebSearchExecutorFromSetting,
  SCHEMA_VERSION,
  type WebSearchExecutor,
} from '@bourse/analysis';
import { ProviderFactoryService } from './provider-factory.service';
import { AiSettingsService } from '../ai-settings/ai-settings.service';
import {
  nameToProviderType,
  providerTypeToName,
} from '../ai-settings/ai-settings.dto';
import { WebSearchSettingsService } from '../web-search-settings/web-search-settings.service';
import { ToolCacheService } from '../lifecycle/tool-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAnalysisDto } from './analysis.dto';
import { parseAnalysisConcurrency } from './concurrency';
import { runStreamComprehensiveAdapter } from './stream-comprehensive-adapter';
import { SnapshotV2Service } from './snapshot-v2.service';

export interface SseCallback {
  (event: string, data: unknown): void;
}

// Canonical comprehensive-workflow order. Plan 3 §3.1: GOVERNANCE follows
// FUNDAMENTAL so governance research builds on the financial picture.
// Order MUST match packages/agent/src/dimensions/index.ts:ALL_DIMENSIONS.
const ALL_SECTION_TYPES = [
  'FUNDAMENTAL', 'GOVERNANCE', 'VALUATION', 'INDUSTRY', 'RISK',
  'TECHNICAL', 'SENTIMENT', 'SCENARIO', 'PORTFOLIO',
] as const;

// Day 11.C: SECTION_SEARCH_CONTEXT (per-section searchContextSize hint)
// removed — `@bourse/analysis`'s ClaudeProvider doesn't accept a
// per-call searchContextSize today (uses Anthropic's default depth);
// OpenAIProvider hard-codes 'high'. Worth re-introducing as a Dimension
// freshness extension when the package's tool middleware grows
// per-section configuration.

@Injectable()
export class AnalysisService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisService.name);
  // plan-v2 Wave 4.1 — cancelledBatches / batchAbortControllers state removed.

  constructor(
    private prisma: PrismaService,
    private providerFactory: ProviderFactoryService,
    private config: ConfigService,
    private aiSettingsService: AiSettingsService,
    private webSearchSettings: WebSearchSettingsService,
    private toolCache: ToolCacheService,
    private snapshotV2: SnapshotV2Service,
  ) {}

  async onModuleInit() {
    // Mark any IN_PROGRESS records orphaned by a previous server restart as FAILED.
    const orphanAnalyses = await this.prisma.analysis.updateMany({
      where: { status: 'IN_PROGRESS' as any },
      data: { status: 'FAILED' as any },
    });
    const orphanSections = await this.prisma.analysisSection.updateMany({
      where: { status: { in: ['IN_PROGRESS', 'PENDING'] } as any, analysis: { status: 'FAILED' } },
      data: { status: 'FAILED' as any, errorMessage: 'Server restarted while running' },
    });
    if (orphanAnalyses.count > 0 || orphanSections.count > 0) {
      this.logger.warn(
        `Reclaimed ${orphanAnalyses.count} orphan analyses and ${orphanSections.count} sections from previous run`,
      );
    }
  }

  async create(userId: string, dto: CreateAnalysisDto) {
    return this.createAnalysisRecord(userId, dto);
  }

  /**
   * Phase 1 — 统一的 provider 解析。优先级：
   *   1. settingIdHint（dto / analysis.aiProviderSettingId）
   *   2. 用户默认 setting（isDefault=true）
   *   3. 回退到 env（用 providerNameHint 决定 Claude/OpenAI，ProviderFactory 自己读 env）
   */
  private async resolveProvider(
    userId: string,
    hints: {
      settingIdHint?: string | null;
      providerNameHint?: string | null;
      modelHint?: string | null;
    },
  ): Promise<{
    provider: ReturnType<ProviderFactoryService['buildProvider']>;
    aiModel: string;
    providerName: string;
    settingId: string | null;
  }> {
    const runtime = await this.resolveRuntime(userId, hints.settingIdHint);

    if (runtime) {
      const provider = this.providerFactory.buildFromRuntime(runtime);
      const aiModel = provider.getModel(hints.modelHint || runtime.model || undefined);
      return {
        provider,
        aiModel,
        providerName: providerTypeToName(runtime.providerType),
        settingId: runtime.id,
      };
    }

    const providerName = this.envProviderName(hints.providerNameHint);
    const provider = this.providerFactory.buildProvider(providerName);
    const aiModel = provider.getModel(hints.modelHint || undefined);
    return { provider, aiModel, providerName, settingId: null };
  }

  /** Shared runtime lookup: explicit settingId hint, else the user's default. */
  private async resolveRuntime(userId: string, settingIdHint?: string | null) {
    const rt = settingIdHint
      ? await this.aiSettingsService.getRuntimeById(userId, settingIdHint)
      : null;
    return rt ?? (await this.aiSettingsService.getDefaultRuntime(userId));
  }

  /** Env-fallback provider name when the user has no AI setting row. */
  private envProviderName(hint?: string | null): string {
    return hint || this.config.get<string>('AI_PROVIDER') || 'claude';
  }

  /**
   * RFC rfc-web-search-backend-config: resolve provider pair (primary +
   * optional fallback) with per-user web_search executors wired. Returns
   * `fallback === undefined` when user hasn't configured a separate
   * fallback adapter — workflow then reuses `primary` for the v1 builder.
   */
  private async resolveProviderPair(
    userId: string,
    hints: {
      settingIdHint?: string | null;
      providerNameHint?: string | null;
      modelHint?: string | null;
      /**
       * RFC rfc-web-search-backend-config §2.4: when provided, the
       * web_search executor is wired with this market's domainTiers so
       * low-tier hosts get filtered post-search.
       */
      market?: string;
    },
  ): Promise<{
    primary: ReturnType<ProviderFactoryService['buildProvider']>;
    fallback?: ReturnType<ProviderFactoryService['buildProvider']>;
    aiModel: string;
    providerName: string;
    settingId: string | null;
  }> {
    const runtime = await this.resolveRuntime(userId, hints.settingIdHint);

    // Resolve the effective provider type BEFORE consulting the web-search
    // setting — `resolveWebSearchRuntime` needs it to apply the Anthropic
    // CUSTOM_ONLY downgrade correctly, and to avoid wiring overrides into
    // a provider that doesn't read them.
    const effectiveProviderType =
      runtime?.providerType ??
      nameToProviderType(this.envProviderName(hints.providerNameHint));

    // plan-v2 §17.4.4 — per-user WebSearchSetting reinstated. Apply override
    // when a row exists; absence still falls through to env / native.
    const { webSearchExecutor, forceChatCompletions } =
      await this.resolveWebSearchRuntime(userId, effectiveProviderType);

    if (runtime) {
      const primary = this.providerFactory.buildFromRuntime({
        ...runtime,
        ...(webSearchExecutor !== undefined ? { webSearchExecutor } : {}),
        ...(forceChatCompletions !== undefined ? { forceChatCompletions } : {}),
      });
      const aiModel = primary.getModel(hints.modelHint || runtime.model || undefined);
      return {
        primary,
        aiModel,
        providerName: providerTypeToName(runtime.providerType),
        settingId: runtime.id,
      };
    }

    const providerName = this.envProviderName(hints.providerNameHint);
    const primary = this.providerFactory.buildProvider(providerName, {
      ...(webSearchExecutor !== undefined ? { webSearchExecutor } : {}),
      ...(forceChatCompletions !== undefined ? { forceChatCompletions } : {}),
    });
    const aiModel = primary.getModel(hints.modelHint || undefined);
    return { primary, aiModel, providerName, settingId: null };
  }

  /**
   * plan-v2 §17.4.4 — read the user's WebSearchSetting and translate it to
   * the (`webSearchExecutor`, `forceChatCompletions`) pair consumed by
   * ProviderFactoryService. Returns both undefined when the user has no
   * row (fall through to env / native).
   *
   * Anthropic + CUSTOM_ONLY combination is silently downgraded to
   * NATIVE_FIRST — the Claude SDK runs web_search server-side and can't
   * accept a custom-shaped tool. UI hides the option, this is the
   * defense-in-depth check for direct PUT.
   */
  private async resolveWebSearchRuntime(
    userId: string,
    providerType: 'ANTHROPIC' | 'OPENAI_COMPATIBLE',
  ): Promise<{
    webSearchExecutor?: WebSearchExecutor | null;
    forceChatCompletions?: boolean;
  }> {
    const row = await this.webSearchSettings.getInternalForRuntime(userId);
    if (!row) return {};

    const customOnly = row.primaryMode === 'CUSTOM_ONLY';
    if (providerType === 'ANTHROPIC') {
      if (customOnly) {
        this.logger.warn(
          `[web-search] user ${userId.slice(0, 8)} chose CUSTOM_ONLY with Anthropic provider; downgrading to NATIVE_FIRST (Claude SDK can't host pluggable adapter)`,
        );
      }
      return {};
    }

    // OpenAI-compatible branch:
    //   NATIVE_FIRST → let Responses API native handle it; don't inject
    //   CUSTOM_ONLY  → build executor + force chat.completions path
    if (!customOnly) return {};

    const executor = buildWebSearchExecutorFromSetting({
      providerType: row.providerType.toLowerCase() as 'tavily' | 'searxng',
      ...(row.apiKey ? { apiKey: row.apiKey } : {}),
      ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      ...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
      ...(row.budgetUsdPerRun !== null
        ? { budgetUsdPerRun: row.budgetUsdPerRun.toNumber() }
        : {}),
      ...(row.cacheTtlMs !== null ? { cacheTtlMs: row.cacheTtlMs } : {}),
    });
    return {
      webSearchExecutor: executor,
      forceChatCompletions: true,
    };
  }

  // plan-v2 Wave 3.1 — DEBATE analysisType + createDebate +
  // resolveDebateRoleModels removed. Bull/bear/judge persona workflow
  // is plan-v2 cut; will be reintroduced as a separate analysisType
  // in v1.x if user demand materializes.

  private logTag(analysisId: string, sectionType?: string) {
    const short = analysisId.slice(-8);
    return sectionType ? `[${short}][${sectionType}]` : `[${short}]`;
  }

  private async createAnalysisRecord(userId: string, dto: CreateAnalysisDto) {
    const stock = await this.prisma.stock.findUnique({
      where: { id: dto.stockId },
    });
    if (!stock) throw new NotFoundException('Stock not found');

    const isComprehensive = dto.analysisType === 'COMPREHENSIVE';
    const { aiModel, providerName, settingId } = await this.resolveProvider(userId, {
      settingIdHint: dto.aiProviderSettingId,
      providerNameHint: dto.aiProvider,
      modelHint: dto.aiModel,
    });

    const sections = isComprehensive
      ? ALL_SECTION_TYPES.map((type, i) => ({ type: type as any, order: i }))
      : [{ type: dto.analysisType as any, order: 0 }];

    const analysis = await this.prisma.analysis.create({
      data: {
        userId,
        stockId: stock.id,
        symbol: stock.symbol,
        market: stock.market,
        analysisType: dto.analysisType as any,
        aiProvider: providerName,
        aiModel,
        aiProviderSettingId: settingId,
        promptVersion: SCHEMA_VERSION,
        sections: { create: sections },
      },
      include: { sections: { orderBy: { order: 'asc' } }, stock: true },
    });

    return analysis;
  }

  // plan-v2 Wave 4.1 — createBatch / getBatch / cancelBatch + BatchJob
  // table removed. plan-v2 §15.1 "BatchJob 砍 — beta 不需要".

  async getById(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
      include: {
        sections: { orderBy: { order: 'asc' } },
        stock: true,
      },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');
    // plan-v2 Wave 2.6d — research summary removed with planner. UI no longer
    // gets plan/snapshot ids on the analysis row.
    return analysis;
  }

  /**
   * Lightweight ownership gate for the /stream endpoint. Avoids the full
   * sections+stock load getById does — runAnalysis re-reads the whole row
   * anyway, and the SSE client reconnects every ~3s, so the heavy read was
   * paid twice per connect.
   */
  async assertOwnership(userId: string, id: string): Promise<void> {
    const row = await this.prisma.analysis.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Analysis not found');
  }

  async getHistory(
    userId: string,
    opts: {
      page?: number;
      limit?: number;
      analysisType?: string;
      status?: string;
      symbol?: string;
      stockId?: string;
      /** RFC rfc-evidence-pack-web-search-fallback: filter to runs whose
       *  EvidencePack came from v1 web_search fallback. */
      degradedOnly?: boolean;
    } = {},
  ) {
    const {
      page = 1,
      limit = 20,
      analysisType,
      status,
      symbol,
      stockId,
      degradedOnly,
    } = opts;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (analysisType) where.analysisType = analysisType;
    if (status) where.status = status;
    if (symbol) where.symbol = { contains: symbol, mode: 'insensitive' };
    if (stockId) where.stockId = stockId;
    if (degradedOnly) where.degradedSource = 'WEB_SEARCH_FALLBACK';

    const [items, total] = await Promise.all([
      this.prisma.analysis.findMany({
        where,
        include: { stock: true, sections: { select: { type: true, status: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.analysis.count({ where }),
    ]);
    // plan-v2 Wave 2.6d — research summary + analysisResearchPlan /
    // analysisResearchSnapshot link tables removed with planner. Every
    // analysis is now 'legacy' mode in the surface; UI badge stays
    // compatible with old shape.
    const itemsWithResearch = items.map((it) => {
      return {
        ...it,
        snapshotIds: [] as string[],
        research: {
          researchMode: 'legacy' as const,
          degradedReasons: [] as string[],
        },
      };
    });
    return { items: itemsWithResearch, total, page, limit };
  }

  // plan-v2 Wave 2.6d — buildResearchSummary removed; getById no longer
  // attaches research summary (planner / plan / snapshot tables gone).

  async delete(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    await this.prisma.analysis.delete({ where: { id } });
    return { ok: true };
  }

  async abort(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id, userId },
      include: { sections: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    if (!['PENDING', 'IN_PROGRESS'].includes(analysis.status)) {
      throw new ForbiddenException('Only PENDING or IN_PROGRESS analyses can be aborted');
    }

    await this.prisma.analysisSection.updateMany({
      where: { analysisId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } as any },
      data: { status: 'FAILED' as any, errorMessage: 'Manually aborted by user (suspected stuck)' },
    });
    await this.prisma.analysis.update({
      where: { id },
      data: { status: 'FAILED' as any },
    });

    return { ok: true };
  }

  async retrySection(userId: string, analysisId: string, sectionId: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id: analysisId, userId },
      include: { sections: true },
    });
    if (!analysis) throw new NotFoundException('Analysis not found');

    const section = analysis.sections.find((s) => s.id === sectionId);
    if (!section) throw new NotFoundException('Section not found');

    if (section.status !== 'FAILED') {
      throw new Error('Only FAILED sections can be retried');
    }

    // Reset section and analysis status
    await this.prisma.analysisSection.update({
      where: { id: sectionId },
      data: {
        status: 'PENDING',
        reportMarkdown: null,
        structuredJson: null as any,
        citations: null as any,
        errorMessage: null,
      },
    });
    await this.prisma.analysis.update({
      where: { id: analysisId },
      data: { status: 'PENDING' },
    });

    return { ok: true };
  }

  async runAnalysis(analysisId: string, send: SseCallback) {
    let analysis = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
      include: { sections: { orderBy: { order: 'asc' } }, stock: true },
    });

    if (!analysis) {
      send('error', { message: 'Analysis not found' });
      return;
    }

    // Replay terminal states instead of rerunning and charging again.
    if (['COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'].includes(analysis.status)) {
      this.replayCompleted(analysis, send);
      return;
    }

    if (analysis.status === 'IN_PROGRESS') {
      // Mid-stream attach: emit a snapshot of current section progress so
      // the polling client (use-analysis-stream.ts) can render real state
      // instead of an empty "正在初始化分析…" loader on every 3s retry.
      // The `error: already running` below still tells the client to keep
      // polling — each retry refreshes with newer progress.
      this.replayInProgress(analysis, send);
      send('error', { message: 'Analysis is already running' });
      return;
    }

    // Claim
    const claimed = await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'IN_PROGRESS' },
    });

    if (claimed.count === 0) {
      analysis = await this.prisma.analysis.findUnique({
        where: { id: analysisId },
        include: { sections: { orderBy: { order: 'asc' } }, stock: true },
      });
      if (analysis?.status === 'COMPLETED') {
        this.replayCompleted(analysis, send);
        return;
      }
      send('error', { message: 'Analysis cannot be started in its current state' });
      return;
    }

    // plan-v2 Wave 2.6d — planner-driven research context removed.
    // EvidencePack now comes from SnapshotV2 (built later in this method);
    // confidenceCap / planDisclaimer / SSE research events are gone with
    // the planner. `researchContext` stays undefined throughout.

    const isComprehensive = analysis.analysisType === 'COMPREHENSIVE';
    const {
      primary: provider,
      fallback: fallbackProvider,
      aiModel,
    } = await this.resolveProviderPair(analysis.userId, {
      settingIdHint: (analysis as any).aiProviderSettingId,
      providerNameHint: analysis.aiProvider,
      modelHint: analysis.aiModel,
      market: analysis.market,
    });
    // Web_search recovery is now always enabled for production runs: it only
    // fires when the structured fetch yields no usable data (no pack / missing
    // financials), where it's the sole path to a non-empty result. The former
    // per-user opt-in (User.allowWebSearchFallback) is obsolete — the column +
    // AI-Settings toggle are pending removal.
    const allowWebSearchFallback = true;
    const failedSections: string[] = [];
    const tag = this.logTag(analysisId);

    // B1 step 3: the adapter (packages/analysis streamComprehensive /
    // streamSingle) is the single orchestration path for ALL analyses —
    // comprehensive → all dims + summary, single → one dim via streamSingle,
    // every market. The legacy hand-rolled path and its feature flag are gone.
    const mode = isComprehensive ? 'comprehensive' : 'single';
    this.logger.log(`${tag} adapter path engaged (mode=${mode})`);
    try {
      await runStreamComprehensiveAdapter({
        mode,
        analysisId,
        analysis,
        provider,
        send,
        prisma: this.prisma,
        toolCache: this.toolCache,
        snapshotV2: this.snapshotV2,
        modelId: aiModel,
        providerName: analysis.aiProvider || 'claude',
        waveSemaphore: parseAnalysisConcurrency(
          this.config.get('ANALYSIS_PARALLEL_CONCURRENCY'),
        ),
        ...(allowWebSearchFallback ? { allowWebSearchFallback: true } : {}),
        ...(fallbackProvider ? { fallbackProvider } : {}),
      });
    } catch (err) {
      // The adapter already writes terminal Analysis state + sends `done`
      // on its own error branch; this catch is a last-resort safety net
      // for unexpected throws outside the adapter's try/catch.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`${tag} adapter unexpected throw: ${msg}`);
    }
  }

  /**
   * Replay state of a still-running analysis: emit section_start (+
   * any partial reportMarkdown) for every section, and section_complete
   * only for those that already reached a terminal status. Sends no
   * summary and no `done` event — those wait for the live run to finish.
   * Caller is expected to follow up with `error: already running` so the
   * client knows to keep polling.
   */
  private replayInProgress(analysis: any, send: SseCallback) {
    for (const section of analysis.sections) {
      send('section_start', {
        sectionType: section.type,
        sectionId: section.id,
        order: section.order,
      });
      if (section.reportMarkdown) {
        send('report_chunk', {
          text: section.reportMarkdown,
          sectionType: section.type,
        });
      }
      const terminal =
        section.status === 'COMPLETED' || section.status === 'FAILED';
      if (!terminal) continue;
      const citations = Array.isArray(section.citations)
        ? section.citations
        : [];
      for (const citation of citations) {
        send('citation', {
          title: citation.title,
          url: citation.url,
          claim: citation.claim || '',
          sectionType: section.type,
        });
      }
      if (section.structuredJson) {
        send('structured_data', {
          json: section.structuredJson,
          sectionType: section.type,
        });
      }
      send('section_complete', {
        sectionType: section.type,
        status: section.status,
        error: section.errorMessage ?? null,
      });
    }
  }

  private replayCompleted(analysis: any, send: SseCallback) {
    for (const section of analysis.sections) {
      this.replaySection(section, send);
    }

    // Replay summary for COMPREHENSIVE
    if (analysis.analysisType === 'COMPREHENSIVE' && analysis.summaryMarkdown) {
      send('summary_chunk', { text: analysis.summaryMarkdown });
      send('report_complete', { sectionType: 'COMPREHENSIVE' });
      if (analysis.summaryJson) {
        send('summary_complete', { summaryJson: analysis.summaryJson });
      }
    }

    send('done', { analysisId: analysis.id });
  }

  // plan-v2 Wave 3.1 — replayDebate / runDebateAnalysis /
  // resolveDebateRoleProviders removed alongside the DEBATE workflow.

  private replaySection(section: any, send: SseCallback) {
    send('section_start', { sectionType: section.type, sectionId: section.id, order: section.order });

    if (section.reportMarkdown) {
      send('report_chunk', { text: section.reportMarkdown, sectionType: section.type });
    }
    send('report_complete', { sectionType: section.type });

    const citations = Array.isArray(section.citations) ? section.citations : [];
    for (const citation of citations) {
      send('citation', {
        title: citation.title,
        url: citation.url,
        claim: citation.claim || '',
        sectionType: section.type,
      });
    }

    if (section.structuredJson) {
      send('structured_data', { json: section.structuredJson, sectionType: section.type });
    }

    send('section_complete', {
      sectionType: section.type,
      status: section.status,
      error: section.errorMessage ?? null,
    });
  }

  // Day 11.C: generateStructuredJson / extractJsonText / validateStructuredJson
  // removed — `@bourse/analysis`'s structuredOutputWithRepair (zod-validated,
  // disclaimer-overriding, repair-on-failure) replaces all three.

  // plan-v2 Wave 4.1 — runBatchJob + updateBatchProgress removed.
}
