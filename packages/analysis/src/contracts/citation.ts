import { z } from 'zod';

export const CitationSourceType = z.enum([
  'NEWS',
  'FILING',
  'RESEARCH',
  'DATA_PROVIDER',
  'SOCIAL',
  'OTHER',
]);
export type CitationSourceType = z.infer<typeof CitationSourceType>;

export const CitationQualityTier = z.enum(['A', 'B', 'C', 'D', 'E']);
export type CitationQualityTier = z.infer<typeof CitationQualityTier>;

export const Citation = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  sourceType: CitationSourceType,
  retrievedAt: z.string().datetime(),
  qualityTier: CitationQualityTier.optional(),
  searchAdapter: z.string().min(1).optional(),
});
export type Citation = z.infer<typeof Citation>;

export const Evidence = z.object({
  claim: z.string().min(1),
  citations: z.array(Citation),
});
export type Evidence = z.infer<typeof Evidence>;
