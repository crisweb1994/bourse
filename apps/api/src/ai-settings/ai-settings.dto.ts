import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';

export const PROVIDER_TYPES = ['ANTHROPIC', 'OPENAI_COMPATIBLE'] as const;
export type ProviderTypeStr = (typeof PROVIDER_TYPES)[number];

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

export class ListModelsDto {
  @IsIn(PROVIDER_TYPES as unknown as string[]) providerType!: ProviderTypeStr;
  @IsString() baseUrl!: string;
  @IsOptional() @IsString() apiKey?: string;
}

export interface AiProviderSettingDto {
  id: string;
  label: string;
  providerType: ProviderTypeStr;
  baseUrl: string;
  apiKey: string | null;
  enabledModels: string[];
  primaryModel: string | null;
  utilityModel: string | null;
  isDefault: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
