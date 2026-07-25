import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateEarningsGenerationDto } from './earnings.dto';
import { EarningsGenerationService } from './earnings-generation.service';
import { EarningsQueryService } from './earnings-query.service';
import { EarningsTrendService } from './earnings-trend.service';

@Controller('earnings')
@UseGuards(JwtCookieGuard)
export class EarningsController {
  constructor(
    private readonly generations: EarningsGenerationService,
    private readonly queries: EarningsQueryService,
    private readonly trends: EarningsTrendService,
  ) {}

  @Get('stocks/:stockId/latest')
  latest(@Param('stockId') stockId: string) {
    return this.queries.latest(stockId);
  }

  @Get('stocks/:stockId/history')
  history(@Param('stockId') stockId: string) {
    return this.queries.history(stockId);
  }

  @Get('stocks/:stockId/trend-options')
  trendOptions(@Param('stockId') stockId: string) {
    return this.trends.options(stockId);
  }

  @Get('stocks/:stockId/trends/:metricCode')
  trend(
    @Param('stockId') stockId: string,
    @Param('metricCode') metricCode: string,
    @Query('periods') periods?: string,
    @Query('fingerprint') fingerprint?: string,
  ) {
    const parsedPeriods = periods === undefined ? 8 : Number(periods);
    if (![4, 8, 12].includes(parsedPeriods)) {
      throw new BadRequestException('periods must be one of 4, 8, or 12');
    }
    return this.trends.series(stockId, metricCode, parsedPeriods, fingerprint);
  }

  @Post('stocks/:stockId/generations')
  @UseGuards(CsrfGuard)
  async create(
    @CurrentUser() user: any,
    @Param('stockId') stockId: string,
    @Body() dto: CreateEarningsGenerationDto,
  ) {
    const run = await this.generations.create(user.id, stockId, dto.clientRequestId);
    return this.queries.generation(user.id, run.id);
  }

  @Get('generations/:runId')
  generation(@CurrentUser() user: any, @Param('runId') runId: string) {
    return this.queries.generation(user.id, runId);
  }

  @Post('generations/:runId/retry')
  @UseGuards(CsrfGuard)
  async retry(@CurrentUser() user: any, @Param('runId') runId: string) {
    await this.generations.retry(user.id, runId);
    return this.queries.generation(user.id, runId);
  }
}
