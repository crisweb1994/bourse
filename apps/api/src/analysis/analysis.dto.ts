import {
  ANALYSIS_MODES,
  FOCUS_WINDOWS,
  type AnalysisMode,
  type FocusWindow,
} from '@bourse/shared-types';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAnalysisDto {
  @IsString()
  stockId!: string;

  @IsIn(ANALYSIS_MODES as unknown as string[])
  mode!: AnalysisMode;

  @IsOptional()
  @IsIn(FOCUS_WINDOWS as unknown as string[])
  focusWindow?: FocusWindow;

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
