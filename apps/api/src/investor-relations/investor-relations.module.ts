import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { FilingsModule } from '../filings/filings.module';
import { InvestorRelationsController } from './investor-relations.controller';
import { InvestorRelationsGenerationService } from './investor-relations-generation.service';
import { InvestorRelationsQueryService } from './investor-relations-query.service';
import { InvestorRelationsRunnerService } from './investor-relations-runner.service';
import { InvestorRelationsSourceService } from './investor-relations-source.service';

@Module({
  imports: [AuthModule, AnalysisModule, ConnectorsModule, FilingsModule],
  controllers: [InvestorRelationsController],
  providers: [
    InvestorRelationsSourceService,
    InvestorRelationsRunnerService,
    InvestorRelationsGenerationService,
    InvestorRelationsQueryService,
  ],
  exports: [InvestorRelationsQueryService],
})
export class InvestorRelationsModule {}
