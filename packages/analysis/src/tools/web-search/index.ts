export {
  SearchQuery,
  SearchResults,
  SearchResultItem,
  WebSearchProviderId,
  WEB_SEARCH_PROVIDER_IDS,
  type AdapterContext,
  type WebSearchAdapter,
  type WebSearchToolOutput,
} from './types';
export {
  loadWebSearchConfigFromEnv,
  type WebSearchEnvConfig,
} from './config';
export { buildAdapterFromConfig, buildAdapterFromEnv } from './registry';
export {
  buildWebSearchExecutorFromSetting,
  type WebSearchSettingInput,
} from './from-setting';
export {
  WebSearchExecutor,
  BudgetExhaustedError,
  type WebSearchExecutorConfig,
  type ExecuteResult,
  type DomainTierFilterConfig,
} from './executor';
export { HallucinationFilter } from './hallucination-filter';
export { createSearxngAdapter } from './adapters/searxng';
// Re-export the provider-internal ToolDescriptor (legacy file path
// `tools/web-search.ts`, now `tools/web-search/provider-internal-descriptor.ts`)
// so `tools/index.ts` keeps its `from './web-search'` import unchanged.
export { webSearch } from './provider-internal-descriptor';

/**
 * Function-tool schema injected into chat.completions requests when an
 * executor is wired. OpenAI / DeepSeek / Qwen / Kimi / 文心 all accept
 * this JSON-Schema shape (function-call protocol; no Responses-API
 * surface needed).
 */
export const WEB_SEARCH_FUNCTION_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      '在互联网上搜索最新信息，返回若干网页的标题、URL 与摘要。当回答需要训练数据之外的实时事实（股价、公告、研报、新闻）时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，使用自然语言或带运算符的查询字符串',
        },
        freshnessDays: {
          type: 'integer',
          description: '仅返回 N 天内的结果（可选）',
          minimum: 1,
          maximum: 365,
        },
      },
      required: ['query'],
    },
  },
};
