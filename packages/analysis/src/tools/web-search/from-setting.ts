/**
 * RFC rfc-web-search-backend-config: build a `WebSearchExecutor` from a
 * per-user setting (instead of process env). The setting layer (apps/api
 * `WebSearchSetting`) hands us a normalized payload and we route it to
 * the right adapter via `buildAdapterFromConfig`.
 *
 * Return value:
 *   - `WebSearchExecutor` — caller injects it into provider construction
 *   - `null` — explicitly "use provider native web_search" (NATIVE
 *              providerType); caller must pass `null` to provider opts
 *              so the SDK falls through to its built-in tool
 *
 * Distinct from `defaultWebSearchExecutorFactory` (env-based) which
 * returns null only when no env config exists. NATIVE here is an
 * **intentional** signal from the user, not a missing-config case.
 */
import {
  WebSearchExecutor,
  type DomainTierFilterConfig,
  type WebSearchExecutorConfig,
} from './executor';
import { buildAdapterFromConfig } from './registry';
import type { WebSearchEnvConfig } from './config';
import type { WebSearchProviderId } from './types';

/**
 * Settings-layer payload. `'NATIVE'` is the only non-WebSearchProviderId
 * value (NATIVE has no adapter, only a marker).
 */
export interface WebSearchSettingInput {
  providerType: 'NATIVE' | WebSearchProviderId;
  baseUrl?: string;
  apiKey?: string;
  /** searxng-only: comma-separated engines passed via query. */
  engines?: string[];
  /** Provider-specific knobs (`cx` for Google PSE, `region` for Bing, …). */
  extraConfig?: Record<string, unknown>;
  /** Soft cap per analysis run. */
  budgetUsdPerRun?: number;
  /** Per-run cache TTL. */
  cacheTtlMs?: number;
  /** Per-search hard timeout. */
  timeoutMs?: number;
  /**
   * RFC rfc-web-search-backend-config §2.4: when the caller (apps/api
   * AnalysisService) has resolved a marketProfile.domainTiers, pass it
   * through here so executor can drop low-tier hosts post-search.
   */
  domainTierFilter?: DomainTierFilterConfig;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_BUDGET_USD = 0.5;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;

export function buildWebSearchExecutorFromSetting(
  input: WebSearchSettingInput,
): WebSearchExecutor | null {
  if (input.providerType === 'NATIVE') return null;

  // `engines` / `extraConfig` are accepted on the input shape so the
  // settings table doesn't have to grow when new adapters land, but
  // registry.ts currently only consumes baseUrl / apiKey. Forwarding the
  // raw payload as-is lets future adapters pick fields off the same
  // envelope without changing this fn.
  const envCfg: WebSearchEnvConfig = {
    providerId: input.providerType,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    budgetPerRunUsd: input.budgetUsdPerRun ?? DEFAULT_BUDGET_USD,
    cacheTtlMs: input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
  };

  const adapter = buildAdapterFromConfig(envCfg);
  const execCfg: WebSearchExecutorConfig = {
    adapter,
    timeoutMs: envCfg.timeoutMs,
    budgetUsdPerRun: envCfg.budgetPerRunUsd,
    cacheTtlMs: envCfg.cacheTtlMs,
    ...(input.domainTierFilter
      ? { domainTierFilter: input.domainTierFilter }
      : {}),
  };
  return new WebSearchExecutor(execCfg);
}
