import { Module, Logger } from '@nestjs/common';
import {
  createCnFilingsConnector,
  createCnFinanceConnector,
  createEastmoneyFinancialsConnector,
  createEastmoneyHkFinancialsConnector,
  createHkexFilingsConnector,
  createNasdaqFinanceConnector,
  createOfficialMacroConnector,
  createSecEdgarFilingsConnector,
  createSecEdgarProfileConnector,
  createSecEdgarXbrlFinancialsConnector,
  createSinaUsFinanceConnector,
  createTencentHkFinanceConnector,
  createTavilySearchConnector,
  createYahooFinanceConnector,
  type FilingPort,
  type CompanyProfilePort,
  type FinancePort,
  type FinancialsPort,
  type MacroPort,
  type SearchPort,
} from '@bourse/analysis';

/**
 * plan-v2 Wave 2.6e — port DI tokens lifted out of the deleted
 * apps/api/src/research/ module so SnapshotV2Service (and any future
 * consumer) doesn't pull in the legacy planner machinery.
 *
 * Provides 6 port singletons:
 *   YAHOO_FINANCE_PORT      — US + HK Yahoo finance
 *   CN_FINANCE_PORT         — Tencent/Eastmoney CN finance
 *   US_FILING_PORT          — SEC EDGAR filings
 *   CN_FILING_PORT          — CNInfo filings
 *   US_FINANCIALS_PORT      — SEC EDGAR XBRL
 *   CN_FINANCIALS_PORT      — Eastmoney datacenter financials
 *   HK_FINANCIALS_PORT      — Eastmoney datacenter HK F10 financials
 */

export const YAHOO_FINANCE_PORT = Symbol('YAHOO_FINANCE_PORT');
export const NASDAQ_FINANCE_PORT = Symbol('NASDAQ_FINANCE_PORT');
export const SINA_US_FINANCE_PORT = Symbol('SINA_US_FINANCE_PORT');
export const TENCENT_HK_FINANCE_PORT = Symbol('TENCENT_HK_FINANCE_PORT');
export const US_PROFILE_PORT = Symbol('US_PROFILE_PORT');
export const CN_FINANCE_PORT = Symbol('CN_FINANCE_PORT');
export const US_FILING_PORT = Symbol('US_FILING_PORT');
export const CN_FILING_PORT = Symbol('CN_FILING_PORT');
export const US_FINANCIALS_PORT = Symbol('US_FINANCIALS_PORT');
export const CN_FINANCIALS_PORT = Symbol('CN_FINANCIALS_PORT');
export const HK_FINANCIALS_PORT = Symbol('HK_FINANCIALS_PORT');
export const HK_FILING_PORT = Symbol('HK_FILING_PORT');
export const OFFICIAL_MACRO_PORT = Symbol('OFFICIAL_MACRO_PORT');
export const TAVILY_SEARCH_PORT = Symbol('TAVILY_SEARCH_PORT');

const SEC_USER_AGENT_FALLBACK = 'stock-suggest-research contact@example.com';

@Module({
  providers: [
    {
      provide: YAHOO_FINANCE_PORT,
      useFactory: (): FinancePort => createYahooFinanceConnector(),
    },
    {
      provide: NASDAQ_FINANCE_PORT,
      useFactory: (): FinancePort => createNasdaqFinanceConnector(),
    },
    {
      provide: SINA_US_FINANCE_PORT,
      useFactory: (): FinancePort => createSinaUsFinanceConnector(),
    },
    {
      provide: TENCENT_HK_FINANCE_PORT,
      useFactory: (): FinancePort => createTencentHkFinanceConnector(),
    },
    {
      provide: US_PROFILE_PORT,
      useFactory: (): CompanyProfilePort =>
        createSecEdgarProfileConnector({
          userAgent:
            process.env.RESEARCH_CORE_USER_AGENT?.trim() || SEC_USER_AGENT_FALLBACK,
        }),
    },
    {
      provide: CN_FINANCE_PORT,
      useFactory: (): FinancePort => createCnFinanceConnector(),
    },
    {
      provide: US_FILING_PORT,
      useFactory: (): FilingPort => {
        const userAgent =
          process.env.RESEARCH_CORE_USER_AGENT?.trim() || SEC_USER_AGENT_FALLBACK;
        if (!process.env.RESEARCH_CORE_USER_AGENT) {
          new Logger('ConnectorsModule').warn(
            'RESEARCH_CORE_USER_AGENT not set — SEC EDGAR may 403 on stricter checks.',
          );
        }
        return createSecEdgarFilingsConnector({ userAgent });
      },
    },
    {
      provide: CN_FILING_PORT,
      useFactory: (): FilingPort => createCnFilingsConnector(),
    },
    {
      provide: HK_FILING_PORT,
      useFactory: (): FilingPort => createHkexFilingsConnector(),
    },
    {
      provide: OFFICIAL_MACRO_PORT,
      useFactory: (): MacroPort => createOfficialMacroConnector(),
    },
    {
      provide: TAVILY_SEARCH_PORT,
      useFactory: (): SearchPort | null => {
        const provider = process.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
        const apiKey = process.env.TAVILY_API_KEY?.trim();
        if (provider !== 'tavily' || !apiKey) return null;
        return createTavilySearchConnector({ apiKey });
      },
    },
    {
      provide: US_FINANCIALS_PORT,
      useFactory: (): FinancialsPort => {
        const userAgent =
          process.env.RESEARCH_CORE_USER_AGENT?.trim() || SEC_USER_AGENT_FALLBACK;
        return createSecEdgarXbrlFinancialsConnector({ userAgent });
      },
    },
    {
      provide: CN_FINANCIALS_PORT,
      useFactory: (): FinancialsPort => createEastmoneyFinancialsConnector(),
    },
    {
      provide: HK_FINANCIALS_PORT,
      useFactory: (): FinancialsPort => createEastmoneyHkFinancialsConnector(),
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
  ],
})
export class ConnectorsModule {}
