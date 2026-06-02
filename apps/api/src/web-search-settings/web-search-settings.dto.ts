import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const WEB_SEARCH_PROVIDER_TYPES = ['TAVILY', 'SEARXNG'] as const;
export type WebSearchProviderTypeStr = (typeof WEB_SEARCH_PROVIDER_TYPES)[number];

export const WEB_SEARCH_PRIMARY_MODES = ['NATIVE_FIRST', 'CUSTOM_ONLY'] as const;
export type WebSearchPrimaryModeStr = (typeof WEB_SEARCH_PRIMARY_MODES)[number];

/**
 * Upsert payload — PUT /api/settings/web-search.
 * 单条 per-user：整体替换语义，不做 patch。客户端始终发完整 body。
 */
export class UpsertWebSearchSettingDto {
  @IsIn(WEB_SEARCH_PROVIDER_TYPES as unknown as string[])
  providerType!: WebSearchProviderTypeStr;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsIn(WEB_SEARCH_PRIMARY_MODES as unknown as string[])
  primaryMode?: WebSearchPrimaryModeStr;

  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(60_000)
  timeoutMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  budgetUsdPerRun?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24 * 60 * 60 * 1000)
  cacheTtlMs?: number;
}

/**
 * Dry-run test body — POST /api/settings/web-search/test. Same shape as
 * upsert, but used without persisting; lets user verify a key works before
 * saving.
 */
export class TestWebSearchSettingDto extends UpsertWebSearchSettingDto {}

/** GET / PUT response shape. */
export interface WebSearchSettingDto {
  providerType: WebSearchProviderTypeStr;
  /** API key masked: `tvly-••••••••JK9F`. Real key never returned. */
  apiKeyMasked: string | null;
  baseUrl: string | null;
  primaryMode: WebSearchPrimaryModeStr;
  timeoutMs: number | null;
  budgetUsdPerRun: number | null;
  cacheTtlMs: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** /test response. */
export interface WebSearchTestResult {
  ok: boolean;
  latencyMs: number;
  /** First result title + url when ok, for human confirmation. */
  sample?: { title: string; url: string };
  /** Error message when !ok. */
  error?: string;
}
