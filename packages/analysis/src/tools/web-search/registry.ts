import { createSearxngAdapter } from './adapters/searxng';
import { createTavilyAdapter } from './adapters/tavily';
import { loadWebSearchConfigFromEnv, type WebSearchEnvConfig } from './config';
import type { WebSearchAdapter } from './types';

/**
 * Build a `WebSearchAdapter` from an env config. Centralizing this here
 * keeps `tools/web-search/index.ts` and provider wiring decoupled from
 * specific adapter modules — adding Serper/Brave later is just one extra
 * `case` here plus an adapter file.
 */
export function buildAdapterFromConfig(
  cfg: WebSearchEnvConfig,
): WebSearchAdapter {
  switch (cfg.providerId) {
    case 'searxng':
      if (!cfg.baseUrl) {
        throw new Error('searxng adapter requires baseUrl');
      }
      return createSearxngAdapter({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
      });
    case 'tavily':
      if (!cfg.apiKey) {
        throw new Error('tavily adapter requires apiKey');
      }
      return createTavilyAdapter({ apiKey: cfg.apiKey });
    default: {
      // Exhaustiveness guard — adding a new id in types.ts but forgetting
      // to register a builder here trips TS instead of a runtime no-op.
      const _exhaustive: never = cfg.providerId;
      throw new Error(`Unknown web-search provider: ${_exhaustive as string}`);
    }
  }
}

/**
 * Convenience: read env + build adapter in one call. Returns null when no
 * provider is configured. Used by provider factory at construction time.
 */
export function buildAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { adapter: WebSearchAdapter; config: WebSearchEnvConfig } | null {
  const cfg = loadWebSearchConfigFromEnv(env);
  if (!cfg) return null;
  return { adapter: buildAdapterFromConfig(cfg), config: cfg };
}
