import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiSettingsModule } from '../ai-settings/ai-settings.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { ProviderFactoryService } from '../analysis/provider-factory.service';
import { DigestController } from './digest.controller';
import { DigestSubscriptionService } from './digest.service';
import { DigestGeneratorService } from './brief.generator';
import { DigestDeliveryService } from './delivery.service';
import { WebhookAdapter } from './channel/webhook.adapter';
import { FeishuAdapter } from './channel/feishu.adapter';
import { TelegramAdapter } from './channel/telegram.adapter';

/**
 * Daily Brief 子系统（docs/prd-daily-brief.md）。
 * task4 订阅 CRUD；task5 生成 BriefPayload；task6 投递（ChannelAdapter + 重试 +
 * DeliveryRecord）。task7 trigger/幂等待加。
 *
 * 依赖注入：
 *  - PrismaService：全局 PrismaModule（无需显式 import）。
 *  - SnapshotV2Service / AiSettingsService：从 AnalysisModule / AiSettingsModule
 *    拿（两者都已 export）。
 *  - ProviderFactoryService：仿照 AnalysisModule 在本 module 本地声明（它只依赖
 *    全局 ConfigService；AnalysisModule 没 export 它，DigestGenerator 需要按用户
 *    AiProviderSetting 构建 provider）。
 *  - 3 个 ChannelAdapter：本地声明，注入 DeliveryService。
 */
@Module({
  imports: [AuthModule, AnalysisModule, AiSettingsModule],
  controllers: [DigestController],
  providers: [
    DigestSubscriptionService,
    DigestGeneratorService,
    DigestDeliveryService,
    ProviderFactoryService,
    WebhookAdapter,
    FeishuAdapter,
    TelegramAdapter,
  ],
  exports: [DigestSubscriptionService, DigestGeneratorService, DigestDeliveryService],
})
export class DigestModule {}
