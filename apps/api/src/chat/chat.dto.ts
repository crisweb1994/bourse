import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateThreadDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}

export class UpdateThreadDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsIn(['archive', 'restore'])
  action?: 'archive' | 'restore';
}

export class CreateChatGenerationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(800)
  question!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  clientRequestId!: string;

  @IsOptional()
  @IsIn(['OPEN_RESEARCH', 'ANALYSIS_GROUNDED'])
  modeHint?: 'OPEN_RESEARCH' | 'ANALYSIS_GROUNDED';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Type(() => String)
  analysisIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sectionTypes?: string[];
}
