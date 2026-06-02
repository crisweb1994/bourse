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

@Module({
  imports: [
    ConfigModule.forRoot({
      // 2026-05-16: monorepo-root .env is the single source of truth for
      // env values now. apps/api/.env / apps/api/.env.local kept in the
      // list only as legacy fallback — anything new should go in the root
      // .env. dotenv loads in array order without overriding existing
      // values, so the root files win against apps/api files.
      envFilePath: [
        '../../.env.local',
        '../../.env',
        '.env.local',
        '.env',
      ],
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    UserModule,
    AiSettingsModule,
    WebSearchSettingsModule,
    StockModule,
    WatchlistModule,
    AnalysisModule,
    // plan-v2 Wave 2.6e — ResearchModule + PlannerModule removed. CRUD
    // surface for research / planner endpoints is gone; AnalysisModule
    // pulls port singletons through ConnectorsModule directly.
    // plan-v2 §12.3 — AgentModule removed; ProviderFactoryService (renamed
    // from AgentRunnerService) now lives inside AnalysisModule.
  ],
})
export class AppModule {}
