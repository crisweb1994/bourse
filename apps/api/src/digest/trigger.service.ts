import { Injectable, Logger } from '@nestjs/common';
import { DigestGeneratorService } from './brief.generator';
import { DigestDeliveryService } from './delivery.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIGEST_MARKETS,
  resolveDigestWindow,
  type DigestMarket,
  type DigestSession,
} from './digest-windows';

/**
 * Daily Brief 触发编排（PRD DB.1 · 模式 C heartbeat）。
 *
 * 一次 heartbeat（不带 market/session）：遍历 US/CN/HK 各判窗口，对命中的
 * (market, session) 遍历所有订阅该 market 的用户，幂等检查（当日已 SENT 跳过），
 * 生成 + 投递。
 *
 * 节假日：Phase A 按窗口时间发（不查成交，PRD §9 留 Phase B）。
 * 幂等键：(market, session, 当地 ymd)，查 DeliveryRecord 是否已有 SENT。
 */
@Injectable()
export class DigestTriggerService {
  private readonly logger = new Logger(DigestTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: DigestGeneratorService,
    private readonly delivery: DigestDeliveryService,
  ) {}

  /**
   * 处理一次 heartbeat。返回命中的 (market, session) 列表（调试/日志用）。
   * 任何单市场/单用户失败不阻塞其它（逐个 try/catch）。
   */
  async runHeartbeat(at: Date = new Date()): Promise<
    { market: DigestMarket; session: DigestSession; delivered: number; skipped: number }[]
  > {
    const results: { market: DigestMarket; session: DigestSession; delivered: number; skipped: number }[] = [];

    for (const market of DIGEST_MARKETS) {
      const hit = resolveDigestWindow(market, at);
      if (!hit) continue; // 不在窗口 → no-op

      const { session, localYmd } = hit;
      try {
        const users = await this.subscribersFor(market);
        if (users.length === 0) continue;

        let delivered = 0;
        let skipped = 0;
        for (const userId of users) {
          const sent = await this.alreadySent(userId, market, session, localYmd);
          if (sent) {
            skipped += 1;
            continue;
          }
          try {
            const payload = await this.generator.generate(userId, market, session);
            await this.delivery.deliver(userId, market, session, payload);
            delivered += 1;
          } catch (err) {
            // 单用户失败不阻塞其它用户；幂等靠 DeliveryRecord，无 SENT 记录
            // 则下次窗口仍会重试（窗口内首次失败 → 下个 heartbeat 补）。
            this.logger.error(
              `brief ${market}/${session} for ${userId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        results.push({ market, session, delivered, skipped });
        this.logger.log(
          `heartbeat hit ${market}/${session} (localYmd=${localYmd}): delivered=${delivered} skipped=${skipped}`,
        );
      } catch (err) {
        this.logger.error(
          `heartbeat ${market}/${session} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return results;
  }

  /** 订阅了该 market 且 enabled 的用户。 */
  private async subscribersFor(market: DigestMarket): Promise<string[]> {
    const subs = await this.prisma.digestSubscription.findMany({
      where: { enabled: true, markets: { has: market } },
      select: { userId: true },
    });
    return subs.map((s) => s.userId);
  }

  /** 当日该 (market, session) 是否已成功投递过（幂等，PRD DB.1 line 236）。 */
  private async alreadySent(
    userId: string,
    market: DigestMarket,
    session: DigestSession,
    localYmd: string,
  ): Promise<boolean> {
    // 当地 ymd 起 0:00-次日 0:00（UTC 近似，窗口内查询足够；精确按交易所 tz 算
    // 窗口日边界略繁，且 SENT 记录只在窗口内产生，UTC 日范围已覆盖）。
    const since = new Date(`${localYmd}T00:00:00Z`);
    const until = new Date(since.getTime() + 86_400_000);
    const count = await this.prisma.deliveryRecord.count({
      where: {
        userId,
        market,
        session,
        status: 'SENT',
        attemptedAt: { gte: since, lt: until },
      },
    });
    return count > 0;
  }
}
