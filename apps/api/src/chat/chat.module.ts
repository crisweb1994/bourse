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
import { ANALYSIS_CHAT_PORT, RESEARCH_GATEWAY_PORT } from './types';

@Module({
  imports: [AuthModule, AnalysisModule, WebSearchSettingsModule, StockModule],
  controllers: [ChatController],
  providers: [
    ThreadService,
    ChatGenerationService,
    ResearchGatewayService,
    { provide: ANALYSIS_CHAT_PORT, useExisting: AnalysisChatService },
    { provide: RESEARCH_GATEWAY_PORT, useExisting: ResearchGatewayService },
  ],
  exports: [ThreadService, ChatGenerationService],
})
export class ChatModule {}
