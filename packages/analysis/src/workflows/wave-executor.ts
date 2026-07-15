import type { SectionType } from '../contracts/enums';
import type { Dimension } from '../dimensions/types';

/**
 * RFC-05 §6.2 / §6.3: wave-based execution helpers.
 *
 * The actual orchestration sits in `streamComprehensive`; this module owns
 * the two purely-functional pieces that benefit most from isolated unit
 * tests:
 *
 *   1. `groupByWave` — partition dims into ordered wave buckets.
 *   2. `runWithSemaphore` — bounded-concurrency runner over an arbitrary
 *      list of async tasks. No knowledge of dims / SSE.
 */

/** A non-empty list of dims that all share the same `wave` number. */
export interface WaveGroup {
  wave: 1 | 2 | 3;
  dims: readonly Dimension[];
}

/**
 * Group dims into ordered waves. Returns at most 3 entries (one per
 * occupied wave). Dims with `wave` undefined default to 1.
 *
 * Preserves the relative order of dims within a wave (caller-provided
 * dim ordering matters for stable SSE seq numbers).
 */
export function groupByWave(
  dims: readonly Dimension[],
): readonly WaveGroup[] {
  const buckets = new Map<1 | 2 | 3, Dimension[]>();
  for (const d of dims) {
    const w = d.wave ?? 1;
    const arr = buckets.get(w) ?? [];
    arr.push(d);
    buckets.set(w, arr);
  }
  const out: WaveGroup[] = [];
  for (const w of [1, 2, 3] as const) {
    const arr = buckets.get(w);
    if (arr && arr.length > 0) {
      out.push({ wave: w, dims: arr });
    }
  }
  return out;
}

/**
 * Run a list of async tasks with at most `limit` running concurrently.
 * Returns results in input order (uses `Promise.allSettled` internally
 * so a rejected task doesn't fail the batch).
 *
 * Tasks are functions, not pre-started promises — this lets the runner
 * decide WHEN to start each, honoring the semaphore. Starting promises
 * up front and then awaiting them would not actually bound concurrency.
 *
 * `limit` < 1 is coerced to 1; `limit` larger than `tasks.length`
 * degrades to "kick everything off at once".
 */
export async function runWithSemaphore<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const n = tasks.length;
  const effectiveLimit = Math.max(1, Math.min(limit, n || 1));
  const results: PromiseSettledResult<T>[] = new Array(n);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= n) return;
      try {
        const value = await tasks[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < effectiveLimit; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Convenience: any fail-run dim that ended up in `failedTypes` after a
 * wave settled. Used by streamComprehensive to halt before the next
 * wave on fail-run failure.
 */
export function findFailRunOffenders(
  dimsInWave: readonly Dimension[],
  failedTypes: ReadonlySet<SectionType>,
): readonly Dimension[] {
  return dimsInWave.filter(
    (d) => d.onFailure === 'fail-run' && failedTypes.has(d.type),
  );
}
