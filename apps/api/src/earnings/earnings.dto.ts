import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateEarningsGenerationDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  clientRequestId!: string;
}
