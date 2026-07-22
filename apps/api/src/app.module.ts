import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { StockModule } from './stock/stock.module';
import { WatchlistModule } from './watchlist/watchlist.module';
import { AnalysisModule } from './analysis/analysis.module';
import { AiSettingsModule } from './ai-settings/ai-settings.module';
import { WebSearchSettingsModule } from './web-search-settings/web-search-settings.module';
import { DigestModule } from './digest/digest.module';
import { ROOT_ENV_FILE_PATHS } from './config/root-env';
import { ChatModule } from './chat/chat.module';
import { MetaController } from './meta/meta.controller';
import { EarningsModule } from './earnings/earnings.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      // Root env files are the only file-based source. Deployment-injected
      // process.env values still override them through ConfigService.
      envFilePath: ROOT_ENV_FILE_PATHS,
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    UserModule,
    AiSettingsModule,
    WebSearchSettingsModule,
    DigestModule,
    StockModule,
    WatchlistModule,
    AnalysisModule,
    ChatModule,
    EarningsModule,
    // plan-v2 Wave 2.6e — ResearchModule + PlannerModule removed. CRUD
    // surface for research / planner endpoints is gone; AnalysisModule
    // pulls port singletons through ConnectorsModule directly.
    // plan-v2 §12.3 — AgentModule removed; ProviderFactoryService (renamed
    // from AgentRunnerService) now lives inside AnalysisModule.
  ],
  controllers: [MetaController],
})
export class AppModule {}
