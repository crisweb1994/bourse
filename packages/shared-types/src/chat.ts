import { z } from 'zod';

export const ChatGenerationStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
]);

export const ChatEventNameSchema = z.enum([
  'generation_status',
  'context_loaded',
  'research_sources',
  'text_block',
  'text_replace',
  'followups',
  'error',
  'done',
]);

export const ChatSsePayloadSchema = z.object({
  event: ChatEventNameSchema,
  seq: z.number().int().nonnegative(),
}).catchall(z.any());

export type ChatSsePayload = z.infer<typeof ChatSsePayloadSchema>;

export const ChatSseEnvelopeSchema = z.object({
  event: ChatEventNameSchema,
  seq: z.number().int().nonnegative(),
  payload: z.record(z.unknown()),
});

export type ChatSseEnvelope = z.infer<typeof ChatSseEnvelopeSchema>;

export const CreateChatGenerationSchema = z.object({
  question: z.string().trim().min(1).max(800),
  clientRequestId: z.string().min(8).max(120),
  modeHint: z.enum(['OPEN_RESEARCH', 'ANALYSIS_GROUNDED']).optional(),
  analysisIds: z.array(z.string()).max(1).optional(),
  sectionTypes: z.array(z.string()).optional(),
});

export type CreateChatGeneration = z.infer<typeof CreateChatGenerationSchema>;
