import { Injectable, Logger } from '@nestjs/common';
import type { BriefPayload, ChannelConfig } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';
import { DigestSubscriptionService } from './digest.service';
import { WebhookAdapter } from './channel/webhook.adapter';
import { FeishuAdapter } from './channel/feishu.adapter';
import { TelegramAdapter } from './channel/telegram.adapter';
import { ChannelAdapter, maskTarget } from './channel/types';

/**
 * Daily Brief 投递编排（PRD DB.6）。
 *
 * 职责：读用户订阅 → 对每个 channel 调对应 adapter 发送 → 失败重试 3 次（指数退避）
 * → 每次投递写 DeliveryRecord。单渠道失败不阻塞其它（Promise.allSettled）。
 *
 * 不做：幂等查询（task7 的窗口判断职责）、Brief 落库（v1.4 不落库）、生成
 * （task5 的 DigestGeneratorService 职责）。本 service 接收**已生成**的 payload。
 */
@Injectable()
export class DigestDeliveryService {
  private readonly logger = new Logger(DigestDeliveryService.name);
  /** channel.type → adapter。新增 IM = 在此注册。 */
  private readonly adapters: ReadonlyMap<ChannelConfig['type'], ChannelAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: DigestSubscriptionService,
    webhook: WebhookAdapter,
    feishu: FeishuAdapter,
    telegram: TelegramAdapter,
  ) {
    const map = new Map<ChannelConfig['type'], ChannelAdapter>();
    map.set(webhook.type, webhook);
    map.set(feishu.type, feishu);
    map.set(telegram.type, telegram);
    this.adapters = map;
  }

  /**
   * 投递一份 brief 到用户订阅的所有渠道。无订阅 / 订阅关闭 → no-op。
   * 单渠道失败不抛（重试 3 次后记 FAILED），不影响其它渠道。
   */
  async deliver(
    userId: string,
    market: 'US' | 'CN' | 'HK',
    session: 'PRE' | 'POST',
    payload: BriefPayload,
  ): Promise<void> {
    const sub = await this.subscriptions.getInternal(userId);
    if (!sub || !sub.enabled || !Array.isArray(sub.channels) || sub.channels.length === 0) {
      return; // 未订阅 / 关闭 / 无渠道 → no-op
    }

    await Promise.allSettled(
      (sub.channels as ChannelConfig[]).map((channel) =>
        this.deliverOne(userId, market, session, channel, payload),
      ),
    );
  }


  /** 单渠道投递：重试 3 次（退避）+ 写 DeliveryRecord。 */
  private async deliverOne(
    userId: string,
    market: 'US' | 'CN' | 'HK',
    session: 'PRE' | 'POST',
    channel: ChannelConfig,
    payload: BriefPayload,
  ): Promise<void> {
    const adapter = this.adapters.get(channel.type);
    if (!adapter) {
      // 未注册的渠道类型（如 SLACK/DINGTARK/WECOM 留 backlog）→ 记 FAILED 不重试。
      await this.record(userId, market, session, channel, 'FAILED', null, `no adapter for ${channel.type}`);
      return;
    }

    const maxAttempts = 3;
    let lastError: string | null = null;
    let lastStatus: number | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const { httpStatus } = await adapter.send(payload, channel as never);
        lastStatus = httpStatus;
        if (httpStatus >= 200 && httpStatus < 300) {
          // 成功（中途重试过也标 RETRYING → 这里直接落 SENT 反映最终态）。
          await this.record(userId, market, session, channel, 'SENT', httpStatus, null);
          return;
        }
        lastError = `HTTP ${httpStatus}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      // 非终态：退避后重试（最后一次不等）。
      if (attempt < maxAttempts) await sleep(backoffMs(attempt));
    }

    await this.record(userId, market, session, channel, 'FAILED', lastStatus, lastError);
    this.logger.warn(
      `deliver ${channel.type}→${maskTarget(channel)} FAILED after ${maxAttempts} attempts: ${lastError}`,
    );
  }

  private async record(
    userId: string,
    market: 'US' | 'CN' | 'HK',
    session: 'PRE' | 'POST',
    channel: ChannelConfig,
    status: 'SENT' | 'FAILED' | 'RETRYING',
    httpStatus: number | null,
    error: string | null,
  ): Promise<void> {
    await this.prisma.deliveryRecord.create({
      data: {
        userId,
        market,
        session,
        channelType: channel.type,
        target: maskTarget(channel),
        status,
        httpStatus,
        error,
      },
    });
  }

}

/** 指数退避：100ms / 400ms / 1.6s（base × 4^attempt）。 */
function backoffMs(attempt: number): number {
  return 100 * 4 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
