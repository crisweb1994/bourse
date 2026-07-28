import { Logger, Module } from '@nestjs/common';
import {
  createMarketDataProviders,
  MarketDataClient,
  type MarketDataProviders,
} from '@bourse/market-data';

export const YAHOO_FINANCE_PORT = Symbol('YAHOO_FINANCE_PORT');
export const NASDAQ_FINANCE_PORT = Symbol('NASDAQ_FINANCE_PORT');
export const SINA_US_FINANCE_PORT = Symbol('SINA_US_FINANCE_PORT');
export const TENCENT_HK_FINANCE_PORT = Symbol('TENCENT_HK_FINANCE_PORT');
export const US_PROFILE_PORT = Symbol('US_PROFILE_PORT');
export const CN_FINANCE_PORT = Symbol('CN_FINANCE_PORT');
export const US_FILING_PORT = Symbol('US_FILING_PORT');
export const CN_FILING_PORT = Symbol('CN_FILING_PORT');
export const HK_FILING_PORT = Symbol('HK_FILING_PORT');
export const US_FINANCIALS_PORT = Symbol('US_FINANCIALS_PORT');
export const CN_FINANCIALS_PORT = Symbol('CN_FINANCIALS_PORT');
export const HK_FINANCIALS_PORT = Symbol('HK_FINANCIALS_PORT');
export const OFFICIAL_MACRO_PORT = Symbol('OFFICIAL_MACRO_PORT');
export const TAVILY_SEARCH_PORT = Symbol('TAVILY_SEARCH_PORT');
export const MARKET_DATA_CLIENT = Symbol('MARKET_DATA_CLIENT');

const MARKET_DATA_PROVIDERS = Symbol('MARKET_DATA_PROVIDERS');
const SEC_USER_AGENT_FALLBACK = 'stock-suggest-research contact@example.com';

const compatibilityProviders = [
  [YAHOO_FINANCE_PORT, 'yahoo'],
  [NASDAQ_FINANCE_PORT, 'nasdaq'],
  [SINA_US_FINANCE_PORT, 'sinaUs'],
  [TENCENT_HK_FINANCE_PORT, 'tencentHk'],
  [US_PROFILE_PORT, 'secProfile'],
  [CN_FINANCE_PORT, 'cnFinance'],
  [US_FILING_PORT, 'usFilings'],
  [CN_FILING_PORT, 'cnFilings'],
  [HK_FILING_PORT, 'hkFilings'],
  [US_FINANCIALS_PORT, 'usFinancials'],
  [CN_FINANCIALS_PORT, 'cnFinancials'],
  [HK_FINANCIALS_PORT, 'hkFinancials'],
  [OFFICIAL_MACRO_PORT, 'macro'],
  [TAVILY_SEARCH_PORT, 'search'],
] as const;

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
        const tavilyEnabled = process.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase() === 'tavily';
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
          ...(tavilyEnabled && process.env.TAVILY_API_KEY?.trim()
            ? { tavilyApiKey: process.env.TAVILY_API_KEY.trim() }
            : {}),
        });
      },
    },
    ...compatibilityProviders.map(([provide, key]) => ({
      provide,
      inject: [MARKET_DATA_PROVIDERS],
      useFactory: (providers: MarketDataProviders): MarketDataProviders[typeof key] =>
        providers[key],
    })),
    {
      provide: MARKET_DATA_CLIENT,
      inject: [MARKET_DATA_PROVIDERS],
      useFactory: (providers: MarketDataProviders): MarketDataClient =>
        new MarketDataClient(providers),
    },
  ],
  exports: [
    YAHOO_FINANCE_PORT,
    NASDAQ_FINANCE_PORT,
    SINA_US_FINANCE_PORT,
    TENCENT_HK_FINANCE_PORT,
    US_PROFILE_PORT,
    CN_FINANCE_PORT,
    US_FILING_PORT,
    CN_FILING_PORT,
    HK_FILING_PORT,
    US_FINANCIALS_PORT,
    CN_FINANCIALS_PORT,
    HK_FINANCIALS_PORT,
    OFFICIAL_MACRO_PORT,
    TAVILY_SEARCH_PORT,
    MARKET_DATA_CLIENT,
  ],
})
export class ConnectorsModule {}
