import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiSettingsModule } from '../ai-settings/ai-settings.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { ProviderFactoryService } from '../analysis/provider-factory.service';
import { DigestController } from './digest.controller';
import { DigestSubscriptionService } from './digest.service';
import { DigestGeneratorService } from './brief.generator';

/**
 * Daily Brief 子系统（docs/prd-daily-brief.md）。
 * task4：订阅 CRUD；task5：DigestGeneratorService（生成 BriefPayload，不落库）。
 * 后续 task6-7 往本 module 加 ChannelAdapter / DigestTriggerController。
 *
 * 依赖注入：
 *  - PrismaService：全局 PrismaModule（无需显式 import）。
 *  - SnapshotV2Service / AiSettingsService：从 AnalysisModule / AiSettingsModule
 *    拿（两者都已 export）。
 *  - ProviderFactoryService：仿照 AnalysisModule 在本 module 本地声明（它只依赖
 *    全局 ConfigService；AnalysisModule 没 export 它，DigestGenerator 需要按用户
 *    AiProviderSetting 构建 provider）。
 */
@Module({
  imports: [AuthModule, AnalysisModule, AiSettingsModule],
  controllers: [DigestController],
  providers: [DigestSubscriptionService, DigestGeneratorService, ProviderFactoryService],
  exports: [DigestSubscriptionService, DigestGeneratorService],
})
export class DigestModule {}
