'use client';

import { useEffect, useRef } from 'react';

const POLL_MS = 1_500;
const ACTIVE_STATUSES = new Set(['QUEUED', 'RUNNING']);

export interface PollableGeneration {
  id: string;
  status: string;
}

interface GenerationPollingHandlers<T> {
  onUpdate: (generation: T) => void;
  onError?: (error: unknown) => void;
}

/** Poll a queued/running generation without leaking late responses. */
export function useGenerationPolling<T extends PollableGeneration>(
  generation: T | null,
  load: (generationId: string) => Promise<T>,
  handlers: GenerationPollingHandlers<T>,
): void {
  const loadRef = useRef(load);
  const onUpdateRef = useRef(handlers.onUpdate);
  const onErrorRef = useRef(handlers.onError);
  loadRef.current = load;
  onUpdateRef.current = handlers.onUpdate;
  onErrorRef.current = handlers.onError;

  useEffect(() => {
    if (!generation || !ACTIVE_STATUSES.has(generation.status)) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void loadRef.current(generation.id)
        .then((next) => {
          if (!cancelled) onUpdateRef.current(next);
        })
        .catch((error: unknown) => {
          if (!cancelled) onErrorRef.current?.(error);
        });
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [generation?.id, generation?.status]);
}
