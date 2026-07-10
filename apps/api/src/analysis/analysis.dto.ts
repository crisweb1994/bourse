import {
  ACTIVE_ANALYSIS_TYPES,
  type ActiveAnalysisType,
} from '@bourse/shared-types';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateAnalysisDto {
  @IsString()
  stockId!: string;

  @IsIn(ACTIVE_ANALYSIS_TYPES as unknown as string[])
  analysisType!: ActiveAnalysisType;

  @IsOptional()
  @IsString()
  aiModel?: string;

  @IsOptional()
  @IsString()
  aiProviderSettingId?: string;
}
