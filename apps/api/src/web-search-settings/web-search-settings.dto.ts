import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  WEB_SEARCH_PRIMARY_MODES,
  WEB_SEARCH_PROVIDER_TYPES,
  type UpsertWebSearchSettingPayload,
  type WebSearchPrimaryMode,
  type WebSearchProviderType,
  type WebSearchSettingDto,
  type WebSearchTestResult,
} from '@bourse/shared-types';

// Wire contract lives in @bourse/shared-types; re-exported for this
// module's existing imports.
export type {
  UpsertWebSearchSettingPayload,
  WebSearchPrimaryMode,
  WebSearchProviderType,
  WebSearchSettingDto,
  WebSearchTestResult,
};

/**
 * Upsert payload — PUT /api/settings/web-search.
 * 单条 per-user：整体替换语义，不做 patch。客户端始终发完整 body。
 */
export class UpsertWebSearchSettingDto implements UpsertWebSearchSettingPayload {
  @IsIn(WEB_SEARCH_PROVIDER_TYPES as unknown as string[])
  providerType!: WebSearchProviderType;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsIn(WEB_SEARCH_PRIMARY_MODES as unknown as string[])
  primaryMode?: WebSearchPrimaryMode;

  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(60_000)
  timeoutMs?: number;

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
