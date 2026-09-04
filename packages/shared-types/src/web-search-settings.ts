// GET/PUT/DELETE /api/settings/web-search contract. Shared between
// apps/api (web-search-settings module) and apps/web (lib/api.ts); the
// class-validator request classes stay in the API — only the wire
// contract and enums live here.

export const WEB_SEARCH_PROVIDER_TYPES = ['TAVILY', 'SEARXNG'] as const;
export type WebSearchProviderType = (typeof WEB_SEARCH_PROVIDER_TYPES)[number];

export const WEB_SEARCH_PRIMARY_MODES = ['NATIVE_FIRST', 'CUSTOM_ONLY'] as const;
export type WebSearchPrimaryMode = (typeof WEB_SEARCH_PRIMARY_MODES)[number];

/** PUT body — single row per user, full-replace semantics. */
export interface UpsertWebSearchSettingPayload {
  providerType: WebSearchProviderType;
  apiKey?: string;
  baseUrl?: string;
  primaryMode?: WebSearchPrimaryMode;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

/** GET / PUT response shape. Timestamps are ISO strings on the wire. */
export interface WebSearchSettingDto {
  providerType: WebSearchProviderType;
  /** API key masked: `tvly-••••••••JK9F`. Real key never returned. */
  apiKeyMasked: string | null;
  baseUrl: string | null;
  primaryMode: WebSearchPrimaryMode;
  timeoutMs: number | null;
  cacheTtlMs: number | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /settings/web-search/test response. */
export interface WebSearchTestResult {
  ok: boolean;
  latencyMs: number;
  /** First result title + url when ok, for human confirmation. */
  sample?: { title: string; url: string };
  /** Error message when !ok. */
  error?: string;
}
