import { WEB_SEARCH_PROVIDER_IDS, type WebSearchProviderId } from './types';

/**
 * Phase 1: env-driven configuration only. Phase 2 introduces a Prisma table
 * `WebSearchSetting` + REST + UI; for now an operator sets:
 *
 *   WEB_SEARCH_PROVIDER=searxng
 *   SEARXNG_BASE_URL=https://searxng.example.com
 *   SEARXNG_API_KEY=...                   # optional, for protected instances
 *   WEB_SEARCH_TIMEOUT_MS=12000           # optional
 *   WEB_SEARCH_BUDGET_PER_RUN_USD=0.10    # optional (informational; SearXNG is free)
 *   WEB_SEARCH_CACHE_TTL_MS=300000        # optional, default 5min
 *
 * When `WEB_SEARCH_PROVIDER` is unset (or set to an unknown id), the
 * executor is treated as unavailable — provider.capabilities.webSearch
 * becomes false on the chat.completions path. Code never throws on missing
 * config; absence is a normal state.
 */
export interface WebSearchEnvConfig {
  providerId: WebSearchProviderId;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  budgetPerRunUsd: number;
  cacheTtlMs: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_BUDGET_PER_RUN_USD = 0.1;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFloatEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Read web-search config from process.env. Returns null when no provider is
 * configured or when the configured provider id is unknown.
 *
 * Side-effect-free; safe to call repeatedly. Caller (e.g. provider factory)
 * decides whether to build an executor or skip wiring.
 */
export function loadWebSearchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WebSearchEnvConfig | null {
  const raw = env.WEB_SEARCH_PROVIDER?.trim();
  if (!raw) return null;
  if (!WEB_SEARCH_PROVIDER_IDS.includes(raw as WebSearchProviderId)) {
    return null;
  }
  const providerId = raw as WebSearchProviderId;

  if (providerId === 'searxng') {
    const baseUrl = env.SEARXNG_BASE_URL?.trim();
    if (!baseUrl) return null; // SearXNG cannot work without an instance URL
    return {
      providerId,
      baseUrl,
      apiKey: env.SEARXNG_API_KEY?.trim() || undefined,
      timeoutMs: parseIntEnv(env.WEB_SEARCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      budgetPerRunUsd: parseFloatEnv(
        env.WEB_SEARCH_BUDGET_PER_RUN_USD,
        DEFAULT_BUDGET_PER_RUN_USD,
      ),
      cacheTtlMs: parseIntEnv(env.WEB_SEARCH_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
    };
  }

  return null;
}
