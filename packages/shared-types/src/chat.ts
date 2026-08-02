import { z } from 'zod';

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
