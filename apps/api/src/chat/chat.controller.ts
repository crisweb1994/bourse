import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  CreateChatGenerationDto,
  CreateThreadDto,
  UpdateThreadDto,
} from './chat.dto';
import { ChatGenerationService } from './generation.service';
import { ThreadService } from './thread.service';
import { AnalysisChatService } from '../analysis/analysis-chat.service';

@Controller('chat')
@UseGuards(JwtCookieGuard)
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly threads: ThreadService,
    private readonly generations: ChatGenerationService,
    private readonly analysis: AnalysisChatService,
  ) {}

  @Post('stocks/:symbol/threads')
  @UseGuards(CsrfGuard)
  createThread(
    @CurrentUser() user: any,
    @Param('symbol') symbol: string,
    @Query('market') market: string | undefined,
    @Body() dto: CreateThreadDto,
  ) {
    return this.threads.create(user.id, symbol, market, dto);
  }

  @Get('stocks/:symbol/threads')
  listThreads(
    @CurrentUser() user: any,
    @Param('symbol') symbol: string,
    @Query('archived') archived?: string,
  ) {
    return this.threads.list(user.id, symbol, archived === 'true' || archived === '1');
  }

  @Get('threads')
  listRecentThreads(
    @CurrentUser() user: any,
    @Query('archived') archived?: string,
  ) {
    return this.threads.listRecent(user.id, archived === 'true' || archived === '1');
  }

  @Get('threads/:threadId')
  async getThread(@CurrentUser() user: any, @Param('threadId') threadId: string) {
    const thread = await this.threads.get(user.id, threadId);
    const eligibleAnalyses = await this.analysis.listEligibleAnalyses({
      userId: user.id,
      stockId: thread.primaryStockId,
    });
    return { ...thread, eligibleAnalyses };
  }

  @Patch('threads/:threadId')
  @UseGuards(CsrfGuard)
  updateThread(
    @CurrentUser() user: any,
    @Param('threadId') threadId: string,
    @Body() dto: UpdateThreadDto,
  ) {
    return this.threads.update(user.id, threadId, dto);
  }

  @Delete('threads/:threadId')
  @UseGuards(CsrfGuard)
  deleteThread(@CurrentUser() user: any, @Param('threadId') threadId: string) {
    return this.threads.remove(user.id, threadId);
  }

  @Post('threads/:threadId/generations')
  @UseGuards(CsrfGuard)
  createGeneration(
    @CurrentUser() user: any,
    @Param('threadId') threadId: string,
    @Body() dto: CreateChatGenerationDto,
  ) {
    return this.generations.create(user.id, threadId, dto);
  }

  @Get('generations/:generationId/stream')
  async stream(
    @CurrentUser() user: any,
    @Param('generationId') generationId: string,
    @Query('afterSeq') afterSeq: string | undefined,
    @Res() res: Response,
  ) {
    // Validate ownership before committing the HTTP response as SSE. Nest can
    // then return a real 404/403 instead of a misleading 200-byte-empty stream.
    await this.generations.getOwnedGeneration(user.id, generationId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const write = (event: { event: string; seq: number; payload: Record<string, unknown> }) => {
      if (closed) return;
      res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      if (event.event === 'done') {
        setImmediate(() => {
          if (!closed) res.end();
        });
      }
    };
    res.on('close', () => {
      closed = true;
      unsubscribe();
    });
    try {
      unsubscribe = await this.generations.subscribe(
        user.id,
        generationId,
        Math.max(0, Number.parseInt(afterSeq ?? '0', 10) || 0),
        write,
      );
    } catch (error) {
      this.logger.error(
        `Chat SSE subscription failed for ${generationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!closed) {
        res.write(`event: error\ndata: ${JSON.stringify({ code: 'STREAM_SUBSCRIBE_FAILED', retryable: true })}\n\n`);
        res.end();
      }
    }
  }

  @Post('generations/:generationId/cancel')
  @UseGuards(CsrfGuard)
  cancel(@CurrentUser() user: any, @Param('generationId') generationId: string) {
    return this.generations.cancel(user.id, generationId);
  }
}
