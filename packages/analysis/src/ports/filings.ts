import type { ResearchResult } from '../contracts/result';
import type { ConnectorRunContext } from '../connectors/types';

export interface FilingSearchInput {
  instrumentId: string;
  forms?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

export interface FilingSummary {
  id: string;
  instrumentId: string;
  formType: string;
  filingDate: string;
  filingUrl: string;
  title?: string;
  provider: string;
}

export interface FilingGetInput {
  id: string;
}

export interface FilingDocument extends FilingSummary {
  text?: string;
  markdown?: string;
}

export interface FilingPort {
  searchFilings(
    input: FilingSearchInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<FilingSummary[]>>;
  getFiling?(
    input: FilingGetInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<FilingDocument>>;
}
