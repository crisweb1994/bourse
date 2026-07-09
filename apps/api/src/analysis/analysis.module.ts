import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiSettingsModule } from '../ai-settings/ai-settings.module';
import { WebSearchSettingsModule } from '../web-search-settings/web-search-settings.module';
import { ToolCacheModule } from '../lifecycle/tool-cache.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { AnalysisLifecycleService } from './analysis-lifecycle.service';
import { AnalysisRunnerService } from './analysis-runner.service';
import { ProviderResolverService } from './provider-resolver.service';
import { ProviderFactoryService } from './provider-factory.service';
import { SnapshotV2Service } from './snapshot-v2.service';

// plan-v2 Wave 2.6e — ResearchModule + PlannerModule deleted; port
// singletons (Yahoo / CN finance / SEC + CNInfo filings / SEC XBRL +
// Eastmoney financials) come from the minimal ConnectorsModule.
// plan-v2 §12.3 — apps/api/src/ai/ deleted; ProviderFactoryService (formerly
// AgentRunnerService) lives inside this module so AgentProvider construction
// is co-located with the only consumer (AnalysisService).
@Module({
  imports: [
    AuthModule,
    AiSettingsModule,
    WebSearchSettingsModule,
    ToolCacheModule,
    ConnectorsModule,
  ],
  controllers: [AnalysisController],
  providers: [
    ProviderResolverService,
    AnalysisService,
    AnalysisLifecycleService,
    AnalysisRunnerService,
    ProviderFactoryService,
    SnapshotV2Service,
  ],
  exports: [SnapshotV2Service],
})
export class AnalysisModule {}
