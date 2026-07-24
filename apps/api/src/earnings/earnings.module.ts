import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ProviderFactoryService } from '../analysis/provider-factory.service';
import { EarningsController } from './earnings.controller';
import { EarningsGenerationService } from './earnings-generation.service';
import { EarningsQueryService } from './earnings-query.service';
import { EarningsRunnerService } from './earnings-runner.service';
import { EarningsSourceService } from './earnings-source.service';
import { FilingDetectionScheduler } from './filing-detection.scheduler';
import { EarningsConsensusService } from './earnings-consensus.service';
import { EarningsConsensusScheduler } from './earnings-consensus.scheduler';
import { EarningsNoticeService } from './earnings-notice.service';
import { EarningsSectionsService } from './earnings-sections.service';
import { EarningsTrendService } from './earnings-trend.service';
import { FilingsModule } from '../filings/filings.module';

@Module({
  imports: [AuthModule, ConnectorsModule, FilingsModule],
  controllers: [EarningsController],
  providers: [
    ProviderFactoryService,
    FilingDetectionScheduler,
    EarningsConsensusService,
    EarningsConsensusScheduler,
    EarningsNoticeService,
    EarningsSectionsService,
    EarningsSourceService,
    EarningsRunnerService,
    EarningsGenerationService,
    EarningsQueryService,
    EarningsTrendService,
  ],
  exports: [EarningsQueryService, EarningsConsensusService, EarningsSectionsService],
})
export class EarningsModule {}
