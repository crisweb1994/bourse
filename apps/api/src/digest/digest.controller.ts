import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import { UpsertDigestSubscriptionDto } from './digest.dto';
import { DigestSubscriptionService } from './digest.service';

/**
 * Daily Brief 订阅 CRUD。PRD DB.6：所有 mutating endpoint 走 JwtCookieGuard +
 * CsrfGuard（x-csrf-token double-submit，不变式 #6）。单条 per-user 整体替换
 * （PUT 语义，与 web-search-settings 一致）。
 */
@Controller('digest/subscription')
@UseGuards(JwtCookieGuard, CsrfGuard)
export class DigestController {
  constructor(private svc: DigestSubscriptionService) {}

  @Get()
  get(@CurrentUser() user: any) {
    return this.svc.get(user.id);
  }

  @Put()
  async upsert(
    @CurrentUser() user: any,
    @Body() dto: UpsertDigestSubscriptionDto,
  ) {
    try {
      return await this.svc.upsert(user.id, dto);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(msg);
    }
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() user: any): Promise<void> {
    await this.svc.remove(user.id);
  }
}
