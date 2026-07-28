import type { ZodSchema } from 'zod';

export interface MarketDataToolCitation {
  title: string;
  url: string;
  sourceType: 'NEWS' | 'FILING' | 'RESEARCH' | 'DATA_PROVIDER' | 'SOCIAL' | 'OTHER';
  retrievedAt: string;
  qualityTier?: 'A' | 'B' | 'C' | 'D' | 'E';
}

export interface MarketDataToolProfile {
  sourcePriorities?: Record<string, string[]>;
}

export interface MarketDataToolContext {
  signal?: AbortSignal;
  marketProfile?: MarketDataToolProfile;
}

export interface MarketDataToolResult<T> {
  data: T;
  citations: MarketDataToolCitation[];
  cost: { tokensIn: number; tokensOut: number; usdEstimate?: number };
  trace?: {
    source?: string;
    durationMs?: number;
    fallbacksTriggered?: number;
    cacheHit?: boolean;
  };
}

export interface MarketDataToolDescriptor<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  providerInternal: boolean;
  inputSchema?: ZodSchema<TInput>;
  market?: string;
  factField?: string;
  outputSchema?: ZodSchema<TOutput>;
  run?: (
    input: TInput,
    ctx: MarketDataToolContext,
  ) => Promise<MarketDataToolResult<TOutput>>;
}
