import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildWebSearchExecutorFromSetting,
  computeContentHash,
} from '@bourse/analysis';
import { WebSearchSettingsService } from '../web-search-settings/web-search-settings.service';
import type {
  ResearchGatewayPort,
  ResearchGatewayResult,
  ChatSourceSnapshot,
} from './types';

/** Shared Research Gateway adapter. Chat receives normalized sources only;
 * it never receives an arbitrary web tool or provider-owned search handle. */
@Injectable()
export class ResearchGatewayService implements ResearchGatewayPort {
  private readonly logger = new Logger(ResearchGatewayService.name);

  constructor(
    private readonly settings: WebSearchSettingsService,
    private readonly config: ConfigService,
  ) {}

  async research(input: {
    userId: string;
    stockId: string;
    symbol: string;
    question: string;
    requestId: string;
  }): Promise<ResearchGatewayResult> {
    const accessedAt = new Date().toISOString();
    const setting = await this.settings.getInternalForRuntime(input.userId).catch(() => null);
    const providerType = setting?.providerType?.toLowerCase() as 'tavily' | 'searxng' | undefined;
    const envProvider = this.config.get<string>('RESEARCH_GATEWAY_PROVIDER')?.toLowerCase();
    const selected = providerType ?? envProvider ?? (this.config.get<string>('TAVILY_API_KEY') ? 'tavily' : 'searxng');
    const apiKey = setting?.apiKey ?? this.config.get<string>('TAVILY_API_KEY');
    const baseUrl = setting?.baseUrl ?? this.config.get<string>('SEARXNG_BASE_URL');

    // No configured adapter is a valid degraded gateway result. The Chat
    // response will state that current sources are unavailable; it will not
    // silently fall back to a private web search implementation.
    if (selected !== 'tavily' && selected !== 'searxng') {
      return { gatewayVersion: 'research-gateway/v1', dataAsOf: accessedAt, sources: [], citationCandidates: [] };
    }

    let executor;
    try {
      executor = buildWebSearchExecutorFromSetting({
        providerType: selected,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(setting?.timeoutMs !== null && setting?.timeoutMs !== undefined
          ? { timeoutMs: setting.timeoutMs }
          : {}),
        ...(setting?.budgetUsdPerRun
          ? { budgetUsdPerRun: setting.budgetUsdPerRun.toNumber() }
          : {}),
        ...(setting?.cacheTtlMs !== null && setting?.cacheTtlMs !== undefined
          ? { cacheTtlMs: setting.cacheTtlMs }
          : {}),
      });
      if (!executor) {
        return { gatewayVersion: 'research-gateway/v1', dataAsOf: accessedAt, sources: [], citationCandidates: [] };
      }
    } catch (error) {
      this.logger.warn(`Research Gateway configuration failed: ${String(error)}`);
      return { gatewayVersion: 'research-gateway/v1', dataAsOf: accessedAt, sources: [], citationCandidates: [] };
    }

    try {
      const result = await executor.execute({
        query: `${input.symbol} ${input.question}`.slice(0, 400),
        count: 8,
      });
      if (result.error) {
        this.logger.warn(`Research Gateway search failed: ${result.error.message}`);
        return { gatewayVersion: 'research-gateway/v1', dataAsOf: accessedAt, sources: [], citationCandidates: [] };
      }
      const sources: ChatSourceSnapshot[] = result.output.results.items.map((item) => ({
        title: item.title,
        url: item.url,
        ...(item.source ? { publisher: item.source } : {}),
        ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        accessedAt,
        ...(item.snippet ? { snippet: item.snippet.slice(0, 1200) } : {}),
        contentHash: computeContentHash({ text: item.snippet || item.url }),
      }));
      const dataAsOf = sources
        .map((source) => source.publishedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? accessedAt;
      return {
        gatewayVersion: 'research-gateway/v1',
        dataAsOf,
        sources,
        citationCandidates: sources.map((_, sourceIndex) => ({
          id: `source-${sourceIndex}`,
          sourceIndex,
        })),
      };
    } catch (error) {
      this.logger.warn(`Research Gateway request failed: ${String(error)}`);
      return { gatewayVersion: 'research-gateway/v1', dataAsOf: accessedAt, sources: [], citationCandidates: [] };
    }
  }
}
