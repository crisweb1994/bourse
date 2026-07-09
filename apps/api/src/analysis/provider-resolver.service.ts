import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildWebSearchExecutorFromSetting,
  type WebSearchExecutor,
} from '@bourse/analysis';
import { ProviderFactoryService } from './provider-factory.service';
import { AiSettingsService } from '../ai-settings/ai-settings.service';
import {
  nameToProviderType,
  providerTypeToName,
} from '../ai-settings/ai-settings.dto';
import { WebSearchSettingsService } from '../web-search-settings/web-search-settings.service';

/**
 * Provider resolution: given a user + hints (settingId / providerName /
 * model / market), produce the concrete `AgentProvider` pair (+ model id +
 * web_search executor) that the analysis runner needs.
 *
 * Extracted from AnalysisService so create-time resolution (createAnalysisRecord)
 * and run-time resolution (runAnalysis) share one home, and neither the CRUD
 * service nor the runner has to carry the provider-pair + web-search wiring
 * logic.
 *
 * This is the bottom of the dependency stack — it injects no other analysis
 * service, so it cannot participate in a cycle.
 */
@Injectable()
export class ProviderResolverService {
  private readonly logger = new Logger(ProviderResolverService.name);

  constructor(
    private providerFactory: ProviderFactoryService,
    private aiSettingsService: AiSettingsService,
    private webSearchSettings: WebSearchSettingsService,
    private config: ConfigService,
  ) {}

  /**
   * Phase 1 — 统一的 provider 解析。优先级：
   *   1. settingIdHint（dto / analysis.aiProviderSettingId）
   *   2. 用户默认 setting（isDefault=true）
   *   3. 回退到 env（用 providerNameHint 决定 Claude/OpenAI，ProviderFactory 自己读 env）
   */
  async resolveProvider(
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
      const aiModel = provider.getModel(
        hints.modelHint || runtime.model || undefined,
      );
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
  async resolveRuntime(userId: string, settingIdHint?: string | null) {
    const rt = settingIdHint
      ? await this.aiSettingsService.getRuntimeById(userId, settingIdHint)
      : null;
    return rt ?? (await this.aiSettingsService.getDefaultRuntime(userId));
  }

  /** Env-fallback provider name when the user has no AI setting row. */
  envProviderName(hint?: string | null): string {
    return hint || this.config.get<string>('AI_PROVIDER') || 'claude';
  }

  /**
   * RFC rfc-web-search-backend-config: resolve provider pair (primary +
   * optional fallback) with per-user web_search executors wired. Returns
   * `fallback === undefined` when user hasn't configured a separate
   * fallback adapter — workflow then reuses `primary` for the v1 builder.
   */
  async resolveProviderPair(
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
      const aiModel = primary.getModel(
        hints.modelHint || runtime.model || undefined,
      );
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
}
