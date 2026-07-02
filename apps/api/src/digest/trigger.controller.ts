import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type { Request } from 'express';
import { DigestTriggerService } from './trigger.service';

/**
 * Daily Brief heartbeat 触发（PRD DB.1 · 模式 C）。
 *
 * 外部 cron 每 15-30 min POST /api/digest/trigger，带 `x-digest-token` header。
 * 不带 market/session——service 内部遍历三市场判窗口。决策 3：token 未配 → 503
 * （运维漏配提示）；header 不匹配 → 401。常量时间比较防 timing attack。
 *
 * 不走 JwtCookieGuard/CSRF：这是机器凭证，不是用户请求（PRD §4 不变式 #6 例外）。
 */
@Controller('digest/trigger')
export class DigestTriggerController {
  constructor(
    private readonly trigger: DigestTriggerService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @HttpCode(202)
  async run(@Headers('x-digest-token') token: string | undefined, @Req() _req: Request) {
    const expected = this.config.get<string>('DIGEST_TRIGGER_TOKEN');
    if (!expected) {
      // 决策 3：env 未配 → 503（运维漏配），不静默放行。
      throw new ServiceUnavailableException('DIGEST_TRIGGER_TOKEN not configured');
    }
    if (!token || !timingSafeEqual(token, expected)) {
      throw new UnauthorizedException('invalid digest token');
    }

    // 202 Accepted：heartbeat 已受理，窗口判断/生成/投递异步语义（实际同步，
    // 但调用方 cron 不关心结果，只关心是否受理）。
    const results = await this.trigger.runHeartbeat();
    return { accepted: true, hits: results };
  }
}

/** 常量时间字符串比较（防 timing attack）。长度不同也固定耗时。 */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // 仍比较一次以固定耗时（不等长时直接 return false，但消耗一次比较）。
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
