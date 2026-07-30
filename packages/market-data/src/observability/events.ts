import type { MarketCode } from '../contracts/instrument';
import type { SourceAttempt } from '../contracts/source-result';
import type { Capability } from '../contracts/source';

export type MarketDataEvent =
  | {
      type: 'route.planned';
      traceId: string;
      capability: Capability;
      market: MarketCode;
      candidates: string[];
    }
  | {
      type: 'source.attempted';
      traceId: string;
      attempt: SourceAttempt;
    }
  | {
      type: 'route.completed';
      traceId: string;
      capability: Capability;
      market: MarketCode;
      status: 'ok' | 'partial' | 'empty' | 'failed';
      attempts: SourceAttempt[];
    };

export interface MarketDataEventSink {
  emit(event: MarketDataEvent): void;
}

export const NOOP_MARKET_DATA_EVENT_SINK: MarketDataEventSink = {
  emit() {},
};
