import { z } from 'zod';
import { FilingSpanSchema } from './earnings';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const InvestorRelationsActivityTypeSchema = z.enum([
  'INSTITUTIONAL_RESEARCH',
  'EARNINGS_BRIEFING',
  'ANALYST_MEETING',
  'ROADSHOW',
  'PHONE_CALL',
  'SITE_VISIT',
  'OTHER',
]);
export type InvestorRelationsActivityType = z.infer<typeof InvestorRelationsActivityTypeSchema>;

export const InvestorRelationsGroundedItemCandidateSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  text: z.string().min(1).max(800),
  sourceQuote: z.string().min(1),
  sourcePage: z.number().int().positive().optional(),
  sourceSection: z.string().min(1).optional(),
});

export const InvestorRelationsExtractionSchema = z.object({
  occurredAt: IsoDateSchema,
  activityType: InvestorRelationsActivityTypeSchema,
  companyParticipants: z.array(z.object({
    name: z.string().min(1).max(100).optional(),
    role: z.string().min(1).max(120).optional(),
  })).default([]),
  institutions: z.array(z.object({ name: z.string().min(1).max(200) })).default([]),
  topics: z.array(InvestorRelationsGroundedItemCandidateSchema).default([]),
  managementClaims: z.array(InvestorRelationsGroundedItemCandidateSchema.omit({ title: true })).default([]),
});
export type InvestorRelationsExtraction = z.infer<typeof InvestorRelationsExtractionSchema>;

export const InvestorRelationsFilingDescriptorSchema = z.object({
  filingId: z.string().min(1),
  formType: z.string().min(1),
  title: z.string().optional(),
  sourceUrl: z.string().url(),
  publishedAt: z.string().datetime(),
  provider: z.string().min(1),
  language: z.enum(['zh-CN', 'zh-HK', 'en-HK', 'en-US', 'unknown']).optional(),
  relationType: z.enum(['PRIMARY', 'SUPPLEMENTS', 'CORRECTS']).optional(),
});

const GroundedItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  text: z.string().min(1),
  sourceSpan: FilingSpanSchema,
});

export const InvestorRelationsRevisionPayloadSchema = z.object({
  schemaVersion: z.string().min(1),
  event: z.object({
    instrumentId: z.string().min(1),
    occurredAt: IsoDateSchema,
    activityType: InvestorRelationsActivityTypeSchema,
    companyParticipants: z.array(z.object({ name: z.string().optional(), role: z.string().min(1) })),
    institutions: z.array(z.object({ name: z.string().min(1) })),
  }),
  filing: InvestorRelationsFilingDescriptorSchema,
  supportingFilings: z.array(InvestorRelationsFilingDescriptorSchema).default([]),
  topics: z.array(GroundedItemSchema.extend({ title: z.string().min(1) })),
  managementClaims: z.array(GroundedItemSchema.omit({ title: true })),
  omittedItemCount: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
});
export type InvestorRelationsRevisionPayload = z.infer<typeof InvestorRelationsRevisionPayloadSchema>;
