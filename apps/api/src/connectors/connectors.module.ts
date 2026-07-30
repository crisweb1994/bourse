import { Logger, Module } from '@nestjs/common';
import {
  createMarketData,
  ResearchMarketDataClient,
} from '@bourse/market-data';

export const MARKET_DATA_CLIENT = Symbol('MARKET_DATA_CLIENT');

const SEC_USER_AGENT_FALLBACK = 'stock-suggest-research contact@example.com';
/**
 * The application owns environment parsing. @bourse/market-data receives
 * constructed source configuration and never reads process.env itself.
 */
@Module({
  providers: [
    {
      provide: MARKET_DATA_CLIENT,
      useFactory: (): ResearchMarketDataClient => {
        const userAgent = process.env.RESEARCH_CORE_USER_AGENT?.trim();
        if (!userAgent) {
          new Logger('ConnectorsModule').warn(
            'RESEARCH_CORE_USER_AGENT not set; SEC EDGAR may reject stricter requests.',
          );
        }
        return createMarketData({
          secUserAgent: userAgent || SEC_USER_AGENT_FALLBACK,
          ...(process.env.TWELVE_DATA_API_KEY?.trim()
            ? { twelveDataApiKey: process.env.TWELVE_DATA_API_KEY.trim() }
            : {}),
          ...(process.env.ALPHA_VANTAGE_API_KEY?.trim()
            ? { alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY.trim() }
            : {}),
          ...(process.env.EODHD_API_KEY?.trim()
            ? { eodhdApiKey: process.env.EODHD_API_KEY.trim() }
            : {}),
        });
      },
    },
  ],
  exports: [MARKET_DATA_CLIENT],
})
export class ConnectorsModule {}
