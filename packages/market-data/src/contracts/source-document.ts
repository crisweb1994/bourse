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
