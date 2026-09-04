import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiSettingsModule } from '../ai-settings/ai-settings.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { DigestController } from './digest.controller';
import { DigestSubscriptionService } from './digest.service';
import { DigestGeneratorService } from './brief.generator';
import { DigestDeliveryService } from './delivery.service';
import { DigestSchedulerService } from './digest-scheduler.service';
import { DigestTriggerService } from './trigger.service';
import { DigestTriggerController } from './trigger.controller';
import { WebhookAdapter } from './channel/webhook.adapter';
import { FeishuAdapter } from './channel/feishu.adapter';
import { TelegramAdapter } from './channel/telegram.adapter';
import { EarningsModule } from '../earnings/earnings.module';

/**
 * Daily Brief 子系统（原专项 PRD "docs/prd-daily-brief.md" 已不在仓库与
 * git 历史中，现状描述见 docs/improve.md「Daily Brief / 行情简报」节；
 * 代码注释里的 "PRD DB.x" 编号沿用该 PRD 的章节号，仅作意图索引）。
 * task4 订阅 CRUD；task5 生成 BriefPayload；task6 投递（ChannelAdapter + 重试 +
 * DeliveryRecord）。task7 trigger/幂等待加。
 *
 * 依赖注入：
 *  - PrismaService：全局 PrismaModule（无需显式 import）。
 *  - SnapshotV2Service / AiSettingsService：从 AnalysisModule / AiSettingsModule
 *    拿（两者都已 export）。
 *  - 3 个 ChannelAdapter：本地声明，注入 DeliveryService。
 */
@Module({
  imports: [AuthModule, AnalysisModule, AiSettingsModule, EarningsModule],
  controllers: [DigestController, DigestTriggerController],
  providers: [
    DigestSubscriptionService,
    DigestGeneratorService,
    DigestDeliveryService,
    DigestTriggerService,
    DigestSchedulerService,
    WebhookAdapter,
    FeishuAdapter,
    TelegramAdapter,
  ],
  exports: [
    DigestSubscriptionService,
    DigestGeneratorService,
    DigestDeliveryService,
    DigestTriggerService,
  ],
})
export class DigestModule {}
