import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AnalysisService } from './analysis.service';
import { AnalysisLifecycleService } from './analysis-lifecycle.service';
import { CreateAnalysisDto } from './analysis.dto';

@Controller('analysis')
@UseGuards(JwtCookieGuard)
export class AnalysisController {
  constructor(
    private analysisService: AnalysisService,
    private lifecycleService: AnalysisLifecycleService,
  ) {}

  @Post()
  @UseGuards(CsrfGuard)
  create(@CurrentUser() user: any, @Body() dto: CreateAnalysisDto) {
    return this.analysisService.create(user.id, dto);
  }

  @Get('history')
  history(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('analysisType') analysisType?: string,
    @Query('status') status?: string,
    @Query('symbol') symbol?: string,
    @Query('stockId') stockId?: string,
    @Query('degradedOnly') degradedOnly?: string,
  ) {
    return this.analysisService.getHistory(user.id, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      analysisType,
      status,
      symbol,
      stockId,
      degradedOnly: degradedOnly === 'true' || degradedOnly === '1',
    });
  }

  // plan-v2 Wave 4.1 — batch endpoints removed. plan-v2 §15.1 "BatchJob 砍".

  @Delete(':id')
  @UseGuards(CsrfGuard)
  delete(@CurrentUser() user: any, @Param('id') id: string) {
    return this.analysisService.delete(user.id, id);
  }

  @Post(':id/abort')
  @UseGuards(CsrfGuard)
  abort(@CurrentUser() user: any, @Param('id') id: string) {
    return this.lifecycleService.abort(user.id, id);
  }

  @Get(':id')
  getById(@CurrentUser() user: any, @Param('id') id: string) {
    return this.analysisService.getById(user.id, id);
  }

  @Post(':id/sections/:sectionId/retry')
  @UseGuards(CsrfGuard)
  retrySection(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Param('sectionId') sectionId: string,
  ) {
    return this.lifecycleService.retrySection(user.id, id, sectionId);
  }

  @Get(':id/stream')
  async stream(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    // Verify ownership (lightweight — runAnalysis re-reads the full row).
    await this.analysisService.assertOwnership(user.id, id);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let disconnected = false;
    res.on('close', () => {
      disconnected = true;
    });

    const wrappedSend = (event: string, data: unknown) => {
      if (!disconnected) {
        send(event, data);
      }
    };

    try {
      await this.analysisService.runAnalysis(id, wrappedSend);
    } catch (err: any) {
      if (!disconnected) {
        send('error', { message: err.message });
      }
    } finally {
      if (!disconnected) {
        res.end();
      }
    }
  }
}
