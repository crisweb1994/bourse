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
import { StockNewsService } from './stock-news.service';

@Controller('stocks')
@UseGuards(JwtCookieGuard)
export class StockController {
  constructor(
    private stockService: StockService,
    private stockNewsService: StockNewsService,
  ) {}

  @Get('search')
  search(@Query('q') query: string) {
    return this.stockService.search(query || '');
  }

  /**
   * Recent announcements feed for the stock header. Filings (SEC EDGAR /
   * HKEX / cninfo) as the primary source, web-search news as best-effort
   * enrichment. Declared before the `:symbol` wildcard so Nest matches the
   * literal `news` segment instead of treating it as a symbol param.
   */
  @Get(':symbol/news')
  async news(
    @Param('symbol') symbol: string,
    @Query('market') market?: string,
    @Query('limit') limit?: string,
  ) {
    if (!symbol) throw new BadRequestException('symbol is required');
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.stockNewsService.getNews(
      symbol,
      market ?? 'US',
      Number.isFinite(parsedLimit) && parsedLimit! > 0
        ? Math.min(parsedLimit!, 20)
        : undefined,
    );
  }

  /**
   * Chart history for the stock page (visualization §五⑦, product decision
   * D3). Server-side deterministic computation only — SMA series / support /
   * resistance come from the same pure functions the analysis snapshot uses
   * (P1: the frontend never computes indicators). `market` defaults to US
   * like the detail endpoint ((symbol, market) is the DB unique tuple, F10);
   * this route does NOT require a DB row — first-visit symbols resolve
   * straight through the capability router (design R-7).
   */
  @Get(':symbol/history')
  async history(
    @Param('symbol') symbol: string,
    @Query('market') market?: string,
    @Query('days') days?: string,
  ) {
    if (!symbol) throw new BadRequestException('symbol is required');
    const parsedDays = days ? Number.parseInt(days, 10) : undefined;
    return this.stockService.getChartHistory(
      symbol,
      market ?? 'US',
      Number.isFinite(parsedDays) ? parsedDays : undefined,
    );
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
