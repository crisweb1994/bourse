import {
  ACTIVE_ANALYSIS_TYPES,
  type ActiveAnalysisType,
} from '@bourse/shared-types';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAnalysisDto {
  @IsString()
  stockId!: string;

  @IsIn(ACTIVE_ANALYSIS_TYPES as unknown as string[])
  analysisType!: ActiveAnalysisType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  question?: string;

  @IsOptional()
  @IsString()
  aiModel?: string;

  @IsOptional()
  @IsString()
  aiProviderSettingId?: string;
}
