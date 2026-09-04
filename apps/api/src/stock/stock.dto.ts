import { IsIn, IsOptional, IsString } from 'class-validator';
import { Market } from '@bourse/shared-types';

export class UpsertStockDto {
  @IsString()
  symbol!: string;

  @IsString()
  name!: string;

  // Search results carry free-form markets (Yahoo returns global listings);
  // the persisted Prisma enum only accepts US/CN/HK. Reject at the boundary
  // with a 400 instead of letting Prisma fail with a 500 downstream.
  @IsIn(Object.values(Market))
  market!: string;

  @IsString()
  exchange!: string;

  @IsString()
  currency!: string;

  @IsOptional()
  @IsString()
  yahooSymbol?: string;
}
