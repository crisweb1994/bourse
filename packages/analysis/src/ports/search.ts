import type { ConnectorRunContext } from '../connectors/types';
import type { MarketCode } from '../contracts/instrument';
import type { ResearchResult } from '../contracts/result';
import type { SourceDocument } from '../contracts/source-document';

export interface WebSearchInput {
  query: string;
  limit?: number;
  freshness?: '1d' | '7d' | '30d' | string;
  language?: string;
  market?: MarketCode;
  /** C3: 白名单，命中才返回 */
  domainAllowlist?: string[];
  /** C3: 黑名单，命中则过滤 */
  domainBlocklist?: string[];
  scrape?: boolean;
}

export interface WebSearchResultItem extends SourceDocument {
  sourceType: 'WEB' | 'NEWS';
  snippet?: string;
  rank?: number;
}

export interface SearchPort {
  searchWeb(
    input: WebSearchInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<WebSearchResultItem[]>>;
}
