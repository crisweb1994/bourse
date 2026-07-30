import { z } from 'zod';
import type { ResearchResult } from '../contracts/result';
import type { SourceResult } from '../contracts/source-result';
import type { ConnectorRunContext } from '../connectors/types';

export interface FilingSearchInput {
  instrumentId: string;
  forms?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

export const FilingSummarySchema = z.object({
  id: z.string().min(1),
  /** Stable identifier inside the provider namespace. */
  sourceDocumentId: z.string().min(1),
  /** Groups attachments belonging to one regulatory submission/announcement. */
  sourceGroupId: z.string().optional(),
  instrumentId: z.string().min(1),
  formType: z.string().min(1),
  filingDate: z.string().min(1),
  /** Regulatory period-of-report date when the provider exposes it. */
  periodEndOn: z.string().optional(),
  filingUrl: z.string().min(1),
  title: z.string().optional(),
  provider: z.string().min(1),
  language: z.enum(['zh-CN', 'zh-HK', 'en-HK', 'en-US', 'unknown']).optional(),
  documentKind: z.enum(['PRIMARY', 'EARNINGS_RELEASE', 'PDF', 'OTHER']).optional(),
});
export type FilingSummary = z.infer<typeof FilingSummarySchema>;

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
  language?: 'zh-CN' | 'zh-HK' | 'en-HK' | 'en-US' | 'unknown';
}

export const FilingPageSchema = z.object({
  page: z.number().int().nonnegative(),
  text: z.string(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
});
export type FilingPage = z.infer<typeof FilingPageSchema>;

export const FilingDocumentSchema = FilingSummarySchema.extend({
  text: z.string().optional(),
  markdown: z.string().optional(),
  mimeType: z.string().optional(),
  rawContent: z.instanceof(Uint8Array).optional(),
  contentHash: z.string().optional(),
  retrievedAt: z.string().optional(),
  pages: z.array(FilingPageSchema).optional(),
});
export type FilingDocument = z.infer<typeof FilingDocumentSchema>;

export interface ProviderFilingPort {
  searchFilings(
    input: FilingSearchInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<FilingSummary[]>>;
  getFiling?(
    input: FilingGetInput,
    ctx?: ConnectorRunContext,
  ): Promise<ResearchResult<FilingDocument>>;
}

export interface FilingPort {
  searchFilings(
    input: FilingSearchInput,
    ctx?: ConnectorRunContext,
  ): Promise<SourceResult<FilingSummary[]>>;
  getFiling?(
    input: FilingGetInput,
    ctx?: ConnectorRunContext,
  ): Promise<SourceResult<FilingDocument>>;
}
