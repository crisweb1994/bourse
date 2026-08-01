import type { ResearchCitation } from './research-citation';
import type { DataFreshness } from './freshness';
import type { ResearchWarning } from './warning';
import type { SourceError } from './errors';

/** Connector-facing result. Routing metadata belongs to the router, not a connector. */
export type SourceResult<T> =
  | {
      status: 'ok';
      data: T;
      sourceId: string;
      citations: ResearchCitation[];
      freshness: DataFreshness[];
      warnings: ResearchWarning[];
    }
  | {
      status: 'empty' | 'failed';
      data: null;
      sourceId: string;
      citations: ResearchCitation[];
      freshness: DataFreshness[];
      warnings: ResearchWarning[];
      error?: SourceError;
    };

export interface SourceAttempt {
  sourceId: string;
  capability: string;
  outcome: 'hit' | 'empty' | 'failed' | 'skipped';
  latencyMs?: number;
  cache: 'hit' | 'miss' | 'stale' | 'bypass';
  reasonCode?: string;
}

/** Router-owned result. It intentionally does not inherit from SourceResult. */
export type RoutedResult<T> =
  | {
      status: 'ok';
      data: T;
      selectedSource?: string;
      mergedSources?: string[];
      citations: ResearchCitation[];
      freshness: DataFreshness[];
      warnings: ResearchWarning[];
      attempts: SourceAttempt[];
    }
  | {
      status: 'partial';
      data: T;
      selectedSource?: string;
      mergedSources?: string[];
      citations: ResearchCitation[];
      freshness: DataFreshness[];
      warnings: ResearchWarning[];
      attempts: SourceAttempt[];
    }
  | {
      status: 'empty';
      data: null;
      citations: ResearchCitation[];
      freshness: DataFreshness[];
      warnings: ResearchWarning[];
      attempts: SourceAttempt[];
      error?: SourceError;
    }
  | {
      status: 'failed';
      data: null;
      citations: ResearchCitation[];
      freshness: DataFreshness[];
      warnings: ResearchWarning[];
      attempts: SourceAttempt[];
      error?: SourceError;
    };
