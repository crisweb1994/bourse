import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import { CreateInvestorRelationsGenerationDto } from './investor-relations.dto';
import { InvestorRelationsGenerationService } from './investor-relations-generation.service';
import { InvestorRelationsQueryService } from './investor-relations-query.service';

@Controller('investor-relations')
@UseGuards(JwtCookieGuard)
export class InvestorRelationsController {
  constructor(private readonly generations: InvestorRelationsGenerationService, private readonly queries: InvestorRelationsQueryService) {}

  @Get('stocks/:stockId/events')
  timeline(@Param('stockId') stockId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.queries.timeline(stockId, cursor, Number(limit ?? 20));
  }

  @Get('events/:eventId')
  detail(@Param('eventId') eventId: string) {
    return this.queries.detail(eventId);
  }

  @Post('stocks/:stockId/generations')
  @UseGuards(CsrfGuard)
  async create(@CurrentUser() user: any, @Param('stockId') stockId: string, @Body() dto: CreateInvestorRelationsGenerationDto) {
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
