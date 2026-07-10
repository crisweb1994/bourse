import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiSettingsModule } from '../ai-settings/ai-settings.module';
import { WebSearchSettingsModule } from '../web-search-settings/web-search-settings.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisCommandService } from './analysis-command.service';
import { AnalysisLifecycleService } from './analysis-lifecycle.service';
import { AnalysisQueryService } from './analysis-query.service';
import { AnalysisReplayService } from './analysis-replay.service';
import { AnalysisRunnerService } from './analysis-runner.service';
import { ProviderResolverService } from './provider-resolver.service';
import { ProviderFactoryService } from './provider-factory.service';
import { SnapshotV2Service } from './snapshot-v2.service';
import { EvidencePackService } from './evidence-pack.service';

// Analysis owns provider construction and imports the market-data connector
// ports used to build evidence packs.
@Module({
  imports: [
    AuthModule,
    AiSettingsModule,
    WebSearchSettingsModule,
    ConnectorsModule,
  ],
  controllers: [AnalysisController],
  providers: [
    ProviderResolverService,
    AnalysisCommandService,
    AnalysisQueryService,
    AnalysisReplayService,
    AnalysisLifecycleService,
    AnalysisRunnerService,
    ProviderFactoryService,
    SnapshotV2Service,
    EvidencePackService,
  ],
  exports: [SnapshotV2Service],
})
export class AnalysisModule {}
