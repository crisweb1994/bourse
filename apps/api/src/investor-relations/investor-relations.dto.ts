import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateInvestorRelationsGenerationDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  clientRequestId!: string;
}
