'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisStreamState } from './use-analysis-stream';

const STUCK_AFTER_MS = 180_000;

/**
 * SSE freshness watchdog. Returns `true` when a streaming analysis has made no
 * visible progress for STUCK_AFTER_MS, so the UI can offer a force-reset.
 *
 * No polling — it tracks a signature of what's been streamed and trips only if
 * that signature stays unchanged. Skips entirely while `attachedElsewhere`
 * (passively waiting on another tab's run has no local progress to track, so
 * the timer would always fire).
 */
export function useStuckWatchdog(
  stream: Pick<
    AnalysisStreamState,
    'status' | 'attachedElsewhere' | 'sections' | 'summaryMarkdown'
  >,
): boolean {
  const [stuckSuspected, setStuckSuspected] = useState(false);
  const lastProgressAtRef = useRef<number>(0);

  const streamSignature = useMemo(() => {
    const parts = Object.values(stream.sections)
      .map((s) => `${s.type}:${s.status}:${s.markdown?.length ?? 0}`)
      .join('|');
    return `${parts}#${stream.summaryMarkdown.length}`;
  }, [stream.sections, stream.summaryMarkdown]);

  useEffect(() => {
    if (stream.status !== 'streaming' || stream.attachedElsewhere) {
      setStuckSuspected(false);
      lastProgressAtRef.current = 0;
      return;
    }
    lastProgressAtRef.current = Date.now();
    setStuckSuspected(false);
    const interval = setInterval(() => {
      if (Date.now() - lastProgressAtRef.current > STUCK_AFTER_MS) {
        setStuckSuspected(true);
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, [stream.status, stream.attachedElsewhere]);

  useEffect(() => {
    if (stream.status !== 'streaming') return;
    lastProgressAtRef.current = Date.now();
    setStuckSuspected(false);
  }, [streamSignature, stream.status]);

  return stuckSuspected;
}
