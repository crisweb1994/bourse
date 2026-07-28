import { z } from 'zod';

export const SourceType = z.enum([
  'WEB',
  'NEWS',
  'FILING',
  'SOCIAL',
  'PRICE',
  'MACRO',
  'RESEARCH',
  'OTHER',
]);
export type SourceType = z.infer<typeof SourceType>;

export const Sensitivity = z.enum(['public', 'restricted', 'private']);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const SourceDocument = z.object({
  id: z.string().optional(),
  sourceType: SourceType,
  provider: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  canonicalUrl: z.string().optional(),
  publishedAt: z.string().optional(),
  retrievedAt: z.string(),
  language: z.string().optional(),
  markdown: z.string().optional(),
  text: z.string().optional(),
  raw: z.unknown().optional(),
  contentHash: z.string().optional(),
  sensitivity: Sensitivity.optional().default('public'),
});
export type SourceDocument = z.infer<typeof SourceDocument>;
