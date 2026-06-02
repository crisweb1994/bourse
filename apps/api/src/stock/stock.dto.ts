import { IsOptional, IsString } from 'class-validator';

export class UpsertStockDto {
  @IsString()
  symbol!: string;

  @IsString()
  name!: string;

  @IsString()
  market!: string;

  @IsString()
  exchange!: string;

  @IsString()
  currency!: string;

  @IsOptional()
  @IsString()
  yahooSymbol?: string;
}
