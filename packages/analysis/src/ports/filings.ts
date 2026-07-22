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
  /** Stable identifier inside the provider namespace. */
  sourceDocumentId: string;
  /** Groups attachments belonging to one regulatory submission/announcement. */
  sourceGroupId?: string;
  instrumentId: string;
  formType: string;
  filingDate: string;
  /** Regulatory period-of-report date when the provider exposes it. */
  periodEndOn?: string;
  filingUrl: string;
  title?: string;
  provider: string;
  documentKind?: 'PRIMARY' | 'EARNINGS_RELEASE' | 'PDF' | 'OTHER';
}

export interface FilingGetInput {
  id: string;
  instrumentId?: string;
  sourceDocumentId?: string;
  sourceGroupId?: string;
  filingUrl?: string;
  filingDate?: string;
  periodEndOn?: string;
  formType?: string;
  title?: string;
  provider?: string;
}

export interface FilingPage {
  page: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface FilingDocument extends FilingSummary {
  text?: string;
  markdown?: string;
  mimeType?: string;
  rawContent?: Uint8Array;
  contentHash?: string;
  retrievedAt?: string;
  pages?: FilingPage[];
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
