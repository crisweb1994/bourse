import { z } from 'zod';
import { AnalysisType } from './enums';

export const CitationSourceType = z.enum([
  'NEWS',
  'FILING',
  'RESEARCH',
  'DATA_PROVIDER',
  'SOCIAL',
  'OTHER',
]);
export type CitationSourceType = z.infer<typeof CitationSourceType>;

// Plan 3 §4.3.4: A-E quality grading. Optional for backwards-compat —
// older stored citations and provider-supplied URLs may not carry it.
// LLM is asked to populate this in the structured-output prompt; missing
// values are treated as 'E' by the evidence gate (Phase 2).
export const CitationQualityTier = z.enum(['A', 'B', 'C', 'D', 'E']);
export type CitationQualityTier = z.infer<typeof CitationQualityTier>;

// Mirrors shared-types Citation, plus optional `dimension` (which dimension
// surfaced this citation). `retrievedAt` is REQUIRED for evidence freshness.
export const Citation = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  sourceType: CitationSourceType,
  retrievedAt: z.string().datetime(),
  qualityTier: CitationQualityTier.optional(),
  dimension: AnalysisType.optional(),
  /**
   * RFC rfc-web-search-backend-config §2.3: which web_search adapter
   * surfaced this URL. Values: 'native' (Anthropic / OpenAI built-in),
   * 'searxng' | 'serper' | 'tavily' | 'brave' | 'bing' | 'google_pse'
   * | 'jina' | 'exa' | string (future). Absent on citations that
   * predate the field or come from non-search sources (e.g. tool
   * gateway output). Frontend uses this for the per-citation source
   * chip; audit pipelines use it for provenance tracking.
   */
  searchAdapter: z.string().min(1).optional(),
});
export type Citation = z.infer<typeof Citation>;

// Per-claim evidence bundle. CLAUDE.md §3 第 17 条 / MVP doc §四 Output guardrail
// require citations.length >= 1 per claim — enforced in the guardrail layer,
// not at schema level (so partial results can still be parsed for inspection).
export const Evidence = z.object({
  claim: z.string().min(1),
  citations: z.array(Citation),
});
export type Evidence = z.infer<typeof Evidence>;
