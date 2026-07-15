import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AgentProvider,
  ClaudeProvider,
  OpenAIProvider,
  type WebSearchExecutor,
} from '@bourse/analysis';
import {
  type ProviderTypeStr,
  providerTypeToName,
} from '../ai-settings/ai-settings.dto';

export interface AgentProviderOverrides {
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  utilityModel?: string | null;
  /** Per-user web-search adapter. Undefined keeps the provider env default. */
  webSearchExecutor?: WebSearchExecutor;
  /** OpenAI-only: route through chat.completions so custom web search runs. */
  forceChatCompletions?: boolean;
}

export interface AgentProviderRuntime extends AgentProviderOverrides {
  providerType: ProviderTypeStr;
}

/**
 * NestJS-injectable factory for `@bourse/analysis` AgentProvider
 * instances. ProviderResolverService supplies per-user runtime settings;
 * this factory only constructs concrete provider objects.
 */
@Injectable()
export class ProviderFactoryService {
  private readonly logger = new Logger(ProviderFactoryService.name);

  constructor(private readonly config: ConfigService) {}

  buildProvider(
    providerName: string,
    overrides?: AgentProviderOverrides,
  ): AgentProvider {
    const name = (providerName || 'claude').toLowerCase();
    if (name === 'openai') return this.buildOpenAI(overrides);
    if (name === 'claude') return this.buildClaude(overrides);
    this.logger.warn(`Unknown provider "${name}", falling back to Claude`);
    return this.buildClaude(overrides);
  }

  /**
   * Convenience entry for an AiSettings runtime row: maps providerType to the
   * builder's short name and delegates to buildProvider. Not reading env —
   * the runtime carries everything; upstream handles fallback.
   */
  buildFromRuntime(runtime: AgentProviderRuntime): AgentProvider {
    const { providerType, ...overrides } = runtime;
    return this.buildProvider(providerTypeToName(providerType), overrides);
  }

  private buildClaude(overrides?: AgentProviderOverrides): ClaudeProvider {
    const apiKey =
      overrides?.apiKey ?? this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      this.logger.warn('No ANTHROPIC_API_KEY configured');
    }
    return new ClaudeProvider({
      apiKey: apiKey ?? 'unset',
      baseUrl: overrides?.baseUrl ?? undefined,
      model:
        overrides?.model ??
        this.config.get<string>('ANTHROPIC_MODEL') ??
        undefined,
      utilityModel:
        overrides?.utilityModel ??
        this.config.get<string>('ANTHROPIC_UTILITY_MODEL') ??
        undefined,
    });
  }

  private buildOpenAI(overrides?: AgentProviderOverrides): OpenAIProvider {
    const apiKey =
      overrides?.apiKey ?? this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('No OPENAI_API_KEY configured');
    }
    const webSearchExecutor = overrides?.webSearchExecutor;
    return new OpenAIProvider({
      apiKey: apiKey ?? 'unset',
      baseUrl:
        overrides?.baseUrl ??
        this.config.get<string>('OPENAI_BASE_URL') ??
        undefined,
      model:
        overrides?.model ??
        this.config.get<string>('OPENAI_MODEL') ??
        undefined,
      utilityModel:
        overrides?.utilityModel ??
        this.config.get<string>('OPENAI_UTILITY_MODEL') ??
        undefined,
      ...(webSearchExecutor
        ? { webSearchExecutorFactory: () => webSearchExecutor }
        : {}),
      ...(overrides?.forceChatCompletions !== undefined
        ? { forceChatCompletions: overrides.forceChatCompletions }
        : {}),
    });
  }
}
