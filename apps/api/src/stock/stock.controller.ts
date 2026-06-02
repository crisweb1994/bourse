import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import { StockService } from './stock.service';

@Controller('stocks')
@UseGuards(JwtCookieGuard)
export class StockController {
  constructor(private stockService: StockService) {}

  @Get('search')
  search(@Query('q') query: string) {
    return this.stockService.search(query || '');
  }

  /**
   * plan-v2 §12.1 — single detail endpoint. Merges the old `lookup`,
   * `:id/quote`, `:id/profile` triple into one call so callers fetch
   * canonical stock + quote + profile in a single round-trip. `market`
   * defaults to US for the AAPL-style short URL; CN / HK callers MUST
   * pass it explicitly because (symbol, market) is the DB unique tuple.
   */
  @Get(':symbol')
  async detail(
    @Param('symbol') symbol: string,
    @Query('market') market?: string,
  ) {
    if (!symbol) throw new BadRequestException('symbol is required');
    return this.stockService.getDetail(symbol, market ?? 'US');
  }
}
