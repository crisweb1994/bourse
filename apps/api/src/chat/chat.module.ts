import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { AnalysisChatService } from '../analysis/analysis-chat.service';
import { WebSearchSettingsModule } from '../web-search-settings/web-search-settings.module';
import { StockModule } from '../stock/stock.module';
import { ChatController } from './chat.controller';
import { ChatGenerationService } from './generation.service';
import { ResearchGatewayService } from './research-gateway.service';
import { ThreadService } from './thread.service';
import { EarningsModule } from '../earnings/earnings.module';
import { InvestorRelationsModule } from '../investor-relations/investor-relations.module';

@Module({
  imports: [AuthModule, AnalysisModule, WebSearchSettingsModule, StockModule, EarningsModule, InvestorRelationsModule],
  controllers: [ChatController],
  providers: [
    ThreadService,
    ChatGenerationService,
    ResearchGatewayService,
  ],
  exports: [ThreadService, ChatGenerationService],
})
export class ChatModule {}
