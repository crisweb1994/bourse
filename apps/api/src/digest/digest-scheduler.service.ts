import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DigestTriggerService } from './trigger.service';

/**
 * Daily Brief 内置 heartbeat 调度（单副本部署用）。
 *
 * 决策（PRD D7 偏离，单副本场景）：用内置 setInterval 替代外部 cron。每 15min
 * tick 一次，复用 DigestTriggerService.runHeartbeat → resolveDigestWindow 判断
 * 窗口（DST 仍由 market-hours.ts 收口，不依赖 node-cron timezone）。幂等保底：
 * 即便 tick 抖动重复也不重复投递（DeliveryRecord 去重）。
 *
 * 已知限制（单副本可接受）：
 *  - 进程在窗口内崩溃/重启 → 该轮可能漏发（无外部告警，靠下次窗口补）
 *  - setInterval 非精确定时（事件循环繁忙时 tick 延迟），但窗口宽 25min / tick
 *    15min，通常仍能命中至少一次
 *  - 多副本部署会重复触发（每个实例各跑一份）→ 不要多副本，或回退外部 cron
 *
 * 保留 POST /api/digest/trigger endpoint：dev 手动触发 / 补偿用（与内置调度并存，
 * 都走 runHeartbeat，幂等保底）。
 *
 * 缓解措施：
 *  - onModuleInit 立即跑一次：进程启动时若在窗口内或刚错过，能补当天（缓解重启漏发）
 *  - runHeartbeat 套硬超时（RUN_TIMEOUT_MS）：防止某次执行挂死导致 running 永真
 *    → 后续 tick 全被跳过
 *  - running 标志：防重叠执行（上次没跑完，本次 tick 跳过）
 */
@Injectable()
export class DigestSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DigestSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** tick 间隔（ms）。15min：覆盖所有市场的 25min 窗口至少一次。 */
  private static readonly TICK_MS = 15 * 60_000;
  /** 单次 runHeartbeat 硬超时（ms）。10min：超过视为挂死，释放 running。 */
  private static readonly RUN_TIMEOUT_MS = 10 * 60_000;

  constructor(private readonly trigger: DigestTriggerService) {}

  onModuleInit(): void {
    // 启动时立即跑一次（缓解：进程启动时若在窗口内或刚错过，能补当天）。
    void this.tick();
    this.timer = setInterval(() => void this.tick(), DigestSchedulerService.TICK_MS);
    this.logger.log(
      `内置 heartbeat 已启动（每 ${DigestSchedulerService.TICK_MS / 60_000}min tick；启动时立即跑一次）`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    // 防重叠：上次未完成则跳过本次（带硬超时兜底，避免 running 永真）。
    if (this.running) {
      this.logger.warn('上一次 heartbeat 未完成，跳过本次 tick');
      return;
    }
    this.running = true;
    try {
      await this.runWithTimeout();
    } catch (err) {
      this.logger.error(
        `heartbeat 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 不抛：单次失败不阻塞后续 tick（下次窗口/下次 tick 自动补）。
    } finally {
      this.running = false;
    }
  }

  /**
   * runHeartbeat + 硬超时。超时 setTimeout 必须在 runHeartbeat 完成后 clearTimeout，
   * 否则每次 tick 留一个 pending 的死 timer（10min），既让进程不退出又泄漏。
   */
  private async runWithTimeout(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.trigger.runHeartbeat(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`heartbeat 超过 ${DigestSchedulerService.RUN_TIMEOUT_MS / 60_000}min 硬超时`)),
            DigestSchedulerService.RUN_TIMEOUT_MS,
          );
          // unref：让这个 timer 不阻止进程优雅退出（onModuleDestroy 时不必等它）。
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
