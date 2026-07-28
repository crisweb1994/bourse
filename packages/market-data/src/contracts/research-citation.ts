import { z } from 'zod';
import { SourceType } from './source-document';

export const QualityTier = z.enum(['A', 'B', 'C', 'D', 'E']);
export type QualityTier = z.infer<typeof QualityTier>;

export const ResearchCitation = z.object({
  title: z.string(),
  url: z.string().optional(),
  sourceType: SourceType,
  provider: z.string(),
  publishedAt: z.string().optional(),
  retrievedAt: z.string(),
  qualityTier: QualityTier.optional(),
});
export type ResearchCitation = z.infer<typeof ResearchCitation>;
