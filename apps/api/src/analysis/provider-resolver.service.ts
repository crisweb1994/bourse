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
 * Shared by create-time commands and run-time execution so neither command
 * handling nor the runner carries provider-pair + web-search wiring logic.
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
   * Resolve the provider used by the workflow, with the user's web-search
   * settings wired into the provider when applicable.
   */
  async resolveProviderPair(
    userId: string,
    hints: {
      settingIdHint?: string | null;
      providerNameHint?: string | null;
      modelHint?: string | null;
    },
  ): Promise<{
    primary: ReturnType<ProviderFactoryService['buildProvider']>;
    aiModel: string;
  }> {
    const runtime = await this.resolveRuntime(userId, hints.settingIdHint);

    // Resolve the effective provider type BEFORE consulting the web-search
    // setting — `resolveWebSearchRuntime` needs it to apply the Anthropic
    // CUSTOM_ONLY downgrade correctly, and to avoid wiring overrides into
    // a provider that doesn't read them.
    const effectiveProviderType =
      runtime?.providerType ??
      nameToProviderType(this.envProviderName(hints.providerNameHint));

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
      };
    }

    const providerName = this.envProviderName(hints.providerNameHint);
    const primary = this.providerFactory.buildProvider(providerName, {
      ...(webSearchExecutor !== undefined ? { webSearchExecutor } : {}),
      ...(forceChatCompletions !== undefined ? { forceChatCompletions } : {}),
    });
    const aiModel = primary.getModel(hints.modelHint || undefined);
    return { primary, aiModel };
  }

  /**
   * Translate the user's web-search setting into provider factory options.
   * Anthropic cannot host a custom web-search adapter, so CUSTOM_ONLY falls
   * back to native provider search.
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
