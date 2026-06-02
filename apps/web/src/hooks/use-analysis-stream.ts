'use client';

import { useState, useCallback, useRef } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { API_URL } from '@/lib/utils';

export interface AnalysisCitation {
  title: string;
  url: string;
  claim?: string;
  sectionType?: string;
  /** RFC rfc-web-search-backend-config §2.3 */
  searchAdapter?: string;
}

export interface SectionData {
  id?: string;
  type: string;
  order: number;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'skipped';
  markdown: string;
  structuredJson: any;
  citations: AnalysisCitation[];
  errorMessage?: string | null;
  /** RFC rfc-evidence-pack-web-search-fallback §2.4: degraded skip. */
  skipReason?: string;
  skipMissingFields?: string[];
}

/**
 * Surfaced when the EvidencePack carries
 * `dataAvailability.degradedSource === 'WEB_SEARCH_FALLBACK'` (derived
 * from `evidence_pack_ready`). Frontends render a banner so users see
 * the data-source switch.
 */
export interface DegradedInfo {
  kind: 'AUTH' | 'NETWORK' | 'RATE_LIMIT_HARD' | 'OTHER';
  failedTools: string[];
  message: string;
}

export interface AnalysisStreamState {
  status: 'idle' | 'streaming' | 'completed' | 'error';
  currentSection: string | null;
  sections: Record<string, SectionData>;
  summaryMarkdown: string;
  summaryJson: any;
  error: string | null;
  analysisId: string | null;
  /** RFC rfc-evidence-pack-web-search-fallback. */
  degraded: DegradedInfo | null;
  /**
   * Backend SSE refuses to attach to an IN_PROGRESS analysis (returns
   * `error: Analysis is already running`). When that happens we don't
   * surface a failure — we poll & reconnect until the analysis enters a
   * terminal state, at which point the stream endpoint replays cached
   * events. This flag tells the UI to render a "另一窗口运行中" notice
   * instead of the failure banner.
   */
  attachedElsewhere: boolean;
}

const INITIAL_STATE: AnalysisStreamState = {
  status: 'idle',
  currentSection: null,
  sections: {},
  summaryMarkdown: '',
  summaryJson: null,
  error: null,
  analysisId: null,
  degraded: null,
  attachedElsewhere: false,
};

const ATTACH_RETRY_MS = 3000;
const ALREADY_RUNNING_RE = /already (running|in progress)/i;

export function useAnalysisStream() {
  const [state, setState] = useState<AnalysisStreamState>(INITIAL_STATE);
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

    // Preserve `attachedElsewhere` across reconnects targeting the same
    // analysisId so the UI doesn't flicker between "另一窗口运行中" and
    // "streaming" while we poll.
    setState((s) => ({
      ...INITIAL_STATE,
      status: 'streaming',
      analysisId,
      attachedElsewhere:
        s.analysisId === analysisId ? s.attachedElsewhere : false,
    }));

    try {
      await fetchEventSource(`${API_URL}/api/analysis/${analysisId}/stream`, {
        signal: ctrl.signal,
        credentials: 'include' as any,
        onmessage(ev) {
          // Drop events from a stale SSE attempt — abort() doesn't flush
          // already-parsed events out of @microsoft/fetch-event-source's
          // internal buffer, so a fast switchover to startStream(B) can
          // see A's tail-end onmessage callbacks fire.
          if (reqIdRef.current !== myReqId) return;
          const data = JSON.parse(ev.data);

          switch (ev.event) {
            // plan-v2 Wave 3.2 — research progress events removed (planner
            // pipeline gone). evidence_pack_ready below is the only remaining
            // pre-stream event; SSE simplification to 5 events is deferred
            // (see §17.4 and improve.md).
            // ---------------------------------------------------------------
            // plan-v2 Wave 3.3: evidence_source_degraded SSE removed.
            // Degraded state is derived from evidence_pack_ready below.
            case 'section_skipped': {
              // RFC rfc-evidence-pack-web-search-fallback §2.4
              const t = data.sectionType;
              setState((s) => {
                const existing = s.sections[t];
                return {
                  ...s,
                  sections: {
                    ...s.sections,
                    [t]: {
                      id: existing?.id,
                      type: t,
                      order: existing?.order ?? Object.keys(s.sections).length,
                      status: 'skipped',
                      markdown: '',
                      structuredJson: null,
                      citations: [],
                      skipReason: data.reason,
                      skipMissingFields: data.missingFields ?? [],
                    },
                  },
                };
              });
              break;
            }
            case 'evidence_pack_ready': {
              // Replay path: if user opens the page after fallback already
              // happened, the standalone SSE event was missed — derive
              // from the pack instead.
              const da = data?.pack?.dataAvailability;
              if (da?.degradedSource === 'WEB_SEARCH_FALLBACK') {
                setState((s) => ({
                  ...s,
                  degraded: s.degraded ?? {
                    kind: da.fallbackReason?.kind ?? 'OTHER',
                    failedTools: da.fallbackReason?.failedTools ?? [],
                    message: da.fallbackReason?.message ?? '',
                  },
                }));
              }
              break;
            }
            case 'section_start': {
              const { sectionType, order, sectionId } = data;
              setState((s) => ({
                ...s,
                currentSection: sectionType,
                sections: {
                  ...s.sections,
                  [sectionType]: {
                    id: sectionId,
                    type: sectionType,
                    order,
                    status: 'streaming',
                    markdown: '',
                    structuredJson: null,
                    citations: [],
                  },
                },
              }));
              break;
            }

            case 'report_chunk': {
              const st = data.sectionType;
              if (st) {
                setState((s) => ({
                  ...s,
                  sections: {
                    ...s.sections,
                    [st]: {
                      ...s.sections[st],
                      markdown: (s.sections[st]?.markdown || '') + data.text,
                    },
                  },
                }));
              } else {
                // Fallback: append to current section
                setState((s) => {
                  const cur = s.currentSection;
                  if (!cur || !s.sections[cur]) return s;
                  return {
                    ...s,
                    sections: {
                      ...s.sections,
                      [cur]: {
                        ...s.sections[cur],
                        markdown: s.sections[cur].markdown + data.text,
                      },
                    },
                  };
                });
              }
              break;
            }

            case 'report_complete':
              break;

            case 'structured_data': {
              const st = data.sectionType;
              if (st && data.json) {
                setState((s) => {
                  // Ignore data for a section we never saw start — spreading
                  // an undefined section would yield a malformed entry with no
                  // markdown/type and crash downstream consumers.
                  if (!s.sections[st]) return s;
                  return {
                    ...s,
                    sections: {
                      ...s.sections,
                      [st]: { ...s.sections[st], structuredJson: data.json },
                    },
                  };
                });
              }
              break;
            }

            case 'citation': {
              const st = data.sectionType;
              const cite = {
                title: data.title,
                url: data.url,
                claim: data.claim,
                sectionType: st,
                ...(data.searchAdapter
                  ? { searchAdapter: data.searchAdapter }
                  : {}),
              };
              setState((s) => {
                const targetType = (st && s.sections[st]) ? st : s.currentSection;
                if (!targetType || !s.sections[targetType]) return s;
                return {
                  ...s,
                  sections: {
                    ...s.sections,
                    [targetType]: {
                      ...s.sections[targetType],
                      citations: [...s.sections[targetType].citations, cite],
                    },
                  },
                };
              });
              break;
            }

            case 'section_complete': {
              const { sectionType: st2, status: secStatus, error } = data;
              setState((s) => {
                if (!s.sections[st2]) return s; // never started — ignore
                return {
                  ...s,
                  sections: {
                    ...s.sections,
                    [st2]: {
                      ...s.sections[st2],
                      status:
                        secStatus === 'COMPLETED' ? 'completed' : 'failed',
                      errorMessage: error ?? null,
                    },
                  },
                };
              });
              break;
            }

            case 'summary_chunk':
              setState((s) => ({
                ...s,
                summaryMarkdown: s.summaryMarkdown + data.text,
              }));
              break;

            case 'summary_complete':
              setState((s) => ({
                ...s,
                summaryJson: data.summaryJson,
              }));
              break;

            case 'done': {
              // Backend (stream-comprehensive-adapter.ts) sends
              // `status: 'COMPLETED'|'PARTIAL_FAILED'|'FAILED'|'CANCELLED'`
              // on done. Previously we hardcoded 'completed' regardless,
              // which made FAILED/CANCELLED runs look successful in the UI
              // (banner condition needs status==='error' OR a failed
              // section count, neither of which fires when the run died
              // in the summary stage with all sections COMPLETED).
              const terminal = typeof data?.status === 'string'
                ? (data.status as string).toUpperCase()
                : 'COMPLETED';
              const failed = terminal === 'FAILED' || terminal === 'CANCELLED';
              setState((s) => ({
                ...s,
                status: failed ? 'error' : 'completed',
                // If the adapter sent a discrete `error` event first, that
                // message is already in s.error — keep it. Otherwise fall
                // back to a generic line so the failure banner has copy.
                error: failed
                  ? s.error || `Run ended in ${terminal}`
                  : s.error,
                // Terminal state reached — whether we got here via direct
                // run or via attach-replay, the "另一处运行" banner is no
                // longer accurate. Clear it so the UI matches reality.
                attachedElsewhere: false,
              }));
              break;
            }

            case 'error':
              // Backend refuses to attach to an IN_PROGRESS analysis. Don't
              // surface as failure — flag it and reconnect after a delay; the
              // SSE handler will hit the replay branch once status flips to
              // a terminal state.
              if (
                typeof data.message === 'string' &&
                ALREADY_RUNNING_RE.test(data.message)
              ) {
                setState((s) => ({
                  ...s,
                  status: 'streaming',
                  attachedElsewhere: true,
                  error: null,
                }));
                clearAttachPoll();
                attachPollRef.current = setTimeout(() => {
                  attachPollRef.current = null;
                  if (ctrl.signal.aborted) return;
                  if (reqIdRef.current !== myReqId) return;
                  void startStream(analysisId);
                }, ATTACH_RETRY_MS);
                break;
              }
              setState((s) => ({
                ...s,
                status: 'error',
                error: data.message,
              }));
              break;
          }
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
            if (s.attachedElsewhere) {
              willRetryAttached = true;
              return s;
            }
            return {
              ...s,
              status: 'error',
              error: err?.message || 'Connection error',
            };
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
    setState((s) => ({
      ...s,
      status: s.status === 'streaming' ? 'completed' : s.status,
      error: s.status === 'streaming' ? null : s.error,
      attachedElsewhere: false,
    }));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    clearAttachPoll();
    reqIdRef.current++;
    setState(INITIAL_STATE);
  }, []);

  return { ...state, startStream, stopStream, reset };
}
