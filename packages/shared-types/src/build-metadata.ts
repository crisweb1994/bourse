import { z } from 'zod';

export const BuildMetadataSchema = z.object({
  version: z.string().min(1),
  commit: z.string().min(1).nullable(),
  builtAt: z.string().datetime().nullable(),
});

export type BuildMetadata = z.infer<typeof BuildMetadataSchema>;
