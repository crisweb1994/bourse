import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  PROVIDER_TYPES,
  type AiProviderSettingDetailDto,
  type AiProviderSettingInput,
  type AiProviderSettingSummaryDto,
  type ProviderTypeStr,
} from '@bourse/shared-types';

// Wire contract lives in @bourse/shared-types; re-exported for this
// module's existing imports.
export type {
  AiProviderSettingDetailDto,
  AiProviderSettingInput,
  AiProviderSettingSummaryDto,
  ProviderTypeStr,
};

// Single source of truth for the providerType ↔ short-name mapping used by
// provider resolution and provider construction.
export function providerTypeToName(t: ProviderTypeStr): 'claude' | 'openai' {
  return t === 'ANTHROPIC' ? 'claude' : 'openai';
}
export function nameToProviderType(name: string): ProviderTypeStr {
  return (name || '').toLowerCase() === 'openai'
    ? 'OPENAI_COMPATIBLE'
    : 'ANTHROPIC';
}

export class CreateAiProviderSettingDto {
  @IsString()
  label!: string;

  @IsIn(PROVIDER_TYPES as unknown as string[])
  providerType!: ProviderTypeStr;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledModels?: string[];

  @IsOptional()
  @IsString()
  primaryModel?: string;

  @IsOptional()
  @IsString()
  utilityModel?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAiProviderSettingDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsIn(PROVIDER_TYPES as unknown as string[])
  providerType?: ProviderTypeStr;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsBoolean()
  clearApiKey?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledModels?: string[];

  @IsOptional()
  @IsString()
  primaryModel?: string;

  @IsOptional()
  @IsString()
  utilityModel?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class TestConnectionDto {
  @IsIn(PROVIDER_TYPES as unknown as string[]) providerType!: ProviderTypeStr;
  @IsString() apiKey!: string;
  @IsOptional() @IsString() baseUrl?: string;
  @IsString() model!: string;
}

export class TestSavedConnectionDto {
  @IsIn(PROVIDER_TYPES as unknown as string[]) providerType!: ProviderTypeStr;
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() baseUrl?: string;
  @IsString() model!: string;
}

export class ListModelsDto {
  @IsIn(PROVIDER_TYPES as unknown as string[]) providerType!: ProviderTypeStr;
  @IsString() baseUrl!: string;
  @IsOptional() @IsString() apiKey?: string;
}
