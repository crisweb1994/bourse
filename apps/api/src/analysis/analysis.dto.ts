import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateAnalysisDto {
  @IsString()
  stockId!: string;

  @IsEnum([
    'FUNDAMENTAL', 'VALUATION', 'INDUSTRY', 'RISK',
    'TECHNICAL', 'SENTIMENT', 'SCENARIO', 'PORTFOLIO',
    'GOVERNANCE', 'COMPREHENSIVE',
  ])
  analysisType!: string;

  @IsOptional()
  @IsString()
  aiProvider?: string;

  @IsOptional()
  @IsString()
  aiModel?: string;

  @IsOptional()
  @IsString()
  aiProviderSettingId?: string;
}

// plan-v2 Wave 3.1 / 4.1 — CreateDebateDto + CreateBatchAnalysisDto removed.
