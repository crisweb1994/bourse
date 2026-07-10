'use client';

import { useState, useCallback, useRef } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { API_URL } from '@/lib/utils';
import {
  applyAnalysisStreamEvent,
  INITIAL_ANALYSIS_STREAM_STATE,
  isAlreadyRunningStreamError,
  markAttachedElsewhere,
  markStreamConnectionError,
  startStreamState,
  stopWatchingStreamState,
  type AnalysisStreamState,
} from './analysis-stream-state';
export type {
  AnalysisCitation,
  AnalysisStreamState,
  DegradedInfo,
  SectionData,
} from './analysis-stream-state';

const ATTACH_RETRY_MS = 3000;

export function useAnalysisStream() {
  const [state, setState] = useState<AnalysisStreamState>(
    INITIAL_ANALYSIS_STREAM_STATE,
  );
  const abortRef = useRef<AbortController | null>(null);
  const attachPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic counter incremented on each startStream call. onmessage /
  // onerror closures capture the request id at attach time and ignore
  // events whose id no longer matches the current one — protects against
  // late-arriving events from a previously aborted SSE corrupting state
  // after the user switched analyses.
  const reqIdRef = useRef(0);

  const clearAttachPoll = () => {
    if (attachPollRef.current) {
      clearTimeout(attachPollRef.current);
      attachPollRef.current = null;
    }
  };

  const startStream = useCallback(async (analysisId: string) => {
    abortRef.current?.abort();
    clearAttachPoll();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const myReqId = ++reqIdRef.current;

    setState((s) => startStreamState(s, analysisId));

    try {
      await fetchEventSource(`${API_URL}/api/analysis/${analysisId}/stream`, {
        signal: ctrl.signal,
        credentials: 'include',
        onmessage(ev) {
          // Drop events from a stale SSE attempt — abort() doesn't flush
          // already-parsed events out of @microsoft/fetch-event-source's
          // internal buffer, so a fast switchover to startStream(B) can
          // see A's tail-end onmessage callbacks fire.
          if (reqIdRef.current !== myReqId) return;
          const data = JSON.parse(ev.data);

          if (ev.event === 'error' && isAlreadyRunningStreamError(data.message)) {
            setState(markAttachedElsewhere);
            clearAttachPoll();
            attachPollRef.current = setTimeout(() => {
              attachPollRef.current = null;
              if (ctrl.signal.aborted) return;
              if (reqIdRef.current !== myReqId) return;
              void startStream(analysisId);
            }, ATTACH_RETRY_MS);
            return;
          }
          setState((s) => applyAnalysisStreamEvent(s, ev.event, data));
        },
        onerror(err) {
          if (ctrl.signal.aborted) return;
          if (reqIdRef.current !== myReqId) return;
          // During attached-elsewhere polling, a transient network blip
          // mid-connection is NOT a failure — the live run is happening
          // elsewhere and we'll just keep polling. Suppress the error
          // banner and schedule the next retry ourselves. Throwing still
          // bails out of fetchEventSource so we don't fight its internal
          // retry loop.
          let willRetryAttached = false;
          setState((s) => {
            willRetryAttached = s.attachedElsewhere;
            return markStreamConnectionError(
              s,
              err?.message || 'Connection error',
            );
          });
          if (willRetryAttached) {
            clearAttachPoll();
            attachPollRef.current = setTimeout(() => {
              attachPollRef.current = null;
              if (ctrl.signal.aborted) return;
              if (reqIdRef.current !== myReqId) return;
              void startStream(analysisId);
            }, ATTACH_RETRY_MS);
          }
          throw err;
        },
        openWhenHidden: true,
      });
    } catch {
      // fetchEventSource throws on abort, ignore
    }
  }, []);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    clearAttachPoll();
    // User pressed "停止" — they want to stop watching, not declare the
    // run failed. Bail out of the streaming UI cleanly: flip status to
    // 'completed' so the failure banner stays hidden and the page shows
    // whatever sections were collected. The backend may still be running;
    // re-attach by reloading or navigating back.
    reqIdRef.current++;
    setState(stopWatchingStreamState);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    clearAttachPoll();
    reqIdRef.current++;
    setState(INITIAL_ANALYSIS_STREAM_STATE);
  }, []);

  return { ...state, startStream, stopStream, reset };
}
