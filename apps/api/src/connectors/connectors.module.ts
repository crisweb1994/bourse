import { Logger, Module } from '@nestjs/common';
import {
  createMarketData,
  parseTushareDataSets,
  parseMassiveCapabilities,
  parseMassiveDelay,
  parseMassiveIntervals,
  ResearchMarketDataClient,
} from '@bourse/market-data';

export const MARKET_DATA_CLIENT = Symbol('MARKET_DATA_CLIENT');

export const SEC_USER_AGENT_FALLBACK = 'stock-suggest-research contact@example.com';
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
          ...(process.env.TUSHARE_TOKEN?.trim() && parseTushareDataSets(process.env.TUSHARE_ENABLED_DATASETS).length > 0
            ? {
                tushare: {
                  token: process.env.TUSHARE_TOKEN.trim(),
                  enabledDataSets: parseTushareDataSets(process.env.TUSHARE_ENABLED_DATASETS),
                  ...(Number(process.env.TUSHARE_REQUESTS_PER_MINUTE) > 0
                    ? { requestsPerMinute: Number(process.env.TUSHARE_REQUESTS_PER_MINUTE) }
                    : {}),
                },
              }
            : {}),
          ...(process.env.MASSIVE_API_KEY?.trim() &&
          parseMassiveCapabilities(process.env.MASSIVE_ENABLED_CAPABILITIES).length > 0 &&
          parseMassiveDelay(process.env.MASSIVE_QUOTE_DELAY)
            ? {
                massive: {
                  apiKey: process.env.MASSIVE_API_KEY.trim(),
                  enabledCapabilities: parseMassiveCapabilities(process.env.MASSIVE_ENABLED_CAPABILITIES),
                  delay: parseMassiveDelay(process.env.MASSIVE_QUOTE_DELAY)!,
                  historyIntervals: parseMassiveIntervals(process.env.MASSIVE_HISTORY_INTERVALS),
                  ...(Number(process.env.MASSIVE_REQUESTS_PER_MINUTE) > 0
                    ? { requestsPerMinute: Number(process.env.MASSIVE_REQUESTS_PER_MINUTE) }
                    : {}),
                },
              }
            : {}),
          ...(process.env.SFC_SHORT_POSITION_CSV_URL?.trim()
            ? { sfcShortPositionCsvUrl: process.env.SFC_SHORT_POSITION_CSV_URL.trim() }
            : {}),
        });
      },
    },
  ],
  exports: [MARKET_DATA_CLIENT],
})
export class ConnectorsModule {}
