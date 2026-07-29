import { Logger, Module } from '@nestjs/common';
import {
  createMarketDataProviders,
  createResearchMarketDataClient,
  ResearchMarketDataClient,
  type MarketDataProviders,
} from '@bourse/market-data';

export const MARKET_DATA_CLIENT = Symbol('MARKET_DATA_CLIENT');
export const YAHOO_FINANCE_PORT = Symbol('YAHOO_FINANCE_PORT');
export const CN_FINANCE_PORT = Symbol('CN_FINANCE_PORT');
export const US_FILING_PORT = Symbol('US_FILING_PORT');
export const CN_FILING_PORT = Symbol('CN_FILING_PORT');
export const HK_FILING_PORT = Symbol('HK_FILING_PORT');
export const US_FINANCIALS_PORT = Symbol('US_FINANCIALS_PORT');
export const CN_FINANCIALS_PORT = Symbol('CN_FINANCIALS_PORT');
export const HK_FINANCIALS_PORT = Symbol('HK_FINANCIALS_PORT');

const SEC_USER_AGENT_FALLBACK = 'stock-suggest-research contact@example.com';
const MARKET_DATA_PROVIDERS = Symbol('MARKET_DATA_PROVIDERS');

const transitionalPorts = [
  [YAHOO_FINANCE_PORT, 'yahoo'],
  [CN_FINANCE_PORT, 'cnFinance'],
  [US_FILING_PORT, 'usFilings'],
  [CN_FILING_PORT, 'cnFilings'],
  [HK_FILING_PORT, 'hkFilings'],
  [US_FINANCIALS_PORT, 'usFinancials'],
  [CN_FINANCIALS_PORT, 'cnFinancials'],
  [HK_FINANCIALS_PORT, 'hkFinancials'],
] as const;

/**
 * The application owns environment parsing. @bourse/market-data receives
 * constructed source configuration and never reads process.env itself.
 */
@Module({
  providers: [
    {
      provide: MARKET_DATA_PROVIDERS,
      useFactory: (): MarketDataProviders => {
        const userAgent = process.env.RESEARCH_CORE_USER_AGENT?.trim();
        if (!userAgent) {
          new Logger('ConnectorsModule').warn(
            'RESEARCH_CORE_USER_AGENT not set; SEC EDGAR may reject stricter requests.',
          );
        }
        return createMarketDataProviders({
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
    // Consensus and filing-document workflows have no v2 capability yet.
    // These tokens are temporary adapters, not a source-selection path.
    ...transitionalPorts.map(([provide, key]) => ({
      provide,
      inject: [MARKET_DATA_PROVIDERS],
      useFactory: (providers: MarketDataProviders): MarketDataProviders[typeof key] => providers[key],
    })),
    {
      provide: MARKET_DATA_CLIENT,
      inject: [MARKET_DATA_PROVIDERS],
      useFactory: (providers: MarketDataProviders): ResearchMarketDataClient => createResearchMarketDataClient(providers),
    },
  ],
  exports: [
    MARKET_DATA_CLIENT,
    YAHOO_FINANCE_PORT,
    CN_FINANCE_PORT,
    US_FILING_PORT,
    CN_FILING_PORT,
    HK_FILING_PORT,
    US_FINANCIALS_PORT,
    CN_FINANCIALS_PORT,
    HK_FINANCIALS_PORT,
  ],
})
export class ConnectorsModule {}
