'use client';

/**
 * use-evidence — chart evidence loader with an explicit state machine
 * (visualization technical design §六, P6/R-6).
 *
 * Mount-fetch keyed by analysisId; `evidence_pack_ready` arriving is used
 * only as a refresh signal by the caller (never the sole trigger — replays
 * without a snapshot never emit that event and must not hang in loading).
 *
 * States: idle → loading → ready | unavailable (terminal) | error (retryable)
 * ready carries degraded as a sub-flag (charts render what they can + a note).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getChartEvidence } from '@/lib/api';
import type { ChartEvidenceResponse } from '@bourse/shared-types';

export type EvidenceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: ChartEvidenceResponse; degraded: boolean }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string };

export function useEvidence(analysisId: string | null | undefined): EvidenceState & {
  /** Manually re-enter loading (SSE refresh signal / retry button). */
  refetch: () => void;
} {
  const [state, setState] = useState<EvidenceState>({ status: 'idle' });
  const generation = useRef(0);

  const load = useCallback(
    (id: string) => {
      const gen = ++generation.current;
      setState({ status: 'loading' });
      getChartEvidence(id)
        .then((data) => {
          if (gen !== generation.current) return;
          if (!data.available) {
            setState({ status: 'unavailable', reason: data.reason ?? 'no_snapshot' });
          } else {
            setState({ status: 'ready', data, degraded: data.degraded });
          }
        })
        .catch((err: unknown) => {
          if (gen !== generation.current) return;
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : '加载失败',
          });
        });
    },
    [],
  );

  useEffect(() => {
    if (!analysisId) {
      generation.current++;
      setState({ status: 'idle' });
      return;
    }
    load(analysisId);
  }, [analysisId, load]);

  const refetch = useCallback(() => {
    if (analysisId) load(analysisId);
  }, [analysisId, load]);

  return { ...state, refetch };
}
