import { z } from 'zod';
import { ResearchCitation } from './research-citation';
import { DataFreshness } from './freshness';
import { ResearchWarning } from './warning';

// plan-v2 Wave 3 D14: renamed from SCHEMA_VERSION / SchemaVersion to avoid
// barrel collision with agent's analysis-result.ts (which exports the
// agent-facing 'agent-result-v1' literal under the same names).
export const RESEARCH_SCHEMA_VERSION = '1.0' as const;
export type ResearchSchemaVersion = typeof RESEARCH_SCHEMA_VERSION;

export const ResearchTrace = z.object({
  runId: z.string().optional(),
  durationMs: z.number().optional(),
  cache: z
    .object({
      hits: z.number(),
      misses: z.number(),
    })
    .optional(),
  providerCalls: z
    .array(
      z.object({
        provider: z.string(),
        operation: z.string(),
        durationMs: z.number(),
        status: z.enum(['OK', 'ERROR', 'TIMEOUT', 'RATE_LIMITED']),
      }),
    )
    .optional(),
  providerCallCount: z.record(z.number()).optional(),
});
export type ResearchTrace = z.infer<typeof ResearchTrace>;

export interface ResearchResult<T> {
  schemaVersion: ResearchSchemaVersion;
  data: T;
  citations: ResearchCitation[];
  freshness: DataFreshness[];
  warnings: ResearchWarning[];
  trace?: ResearchTrace;
}

export interface OrchestratorOptions {
  strict?: boolean;
  traceMode?: 'none' | 'summary' | 'detailed';
  cacheMode?: 'prefer-fresh' | 'allow-stale' | 'bypass';
}

export class ResearchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ResearchError';
  }
}
