import { IsOptional, IsString } from 'class-validator';

export class AddWatchlistDto {
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

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateWatchlistDto {
  @IsOptional()
  @IsString()
  notes?: string;
}
