import { describe, expect, it } from 'vitest';
import type { AnalysisType } from '../../contracts/enums';
import type { Dimension } from '../../dimensions/types';
import {
  findFailRunOffenders,
  groupByWave,
  runWithSemaphore,
} from '../../workflows/wave-executor';

/** Minimal Dimension stub: only the fields wave-executor inspects. */
function dim(
  type: AnalysisType,
  wave?: 1 | 2 | 3,
  onFailure: 'skip' | 'retry-once' | 'fail-run' = 'skip',
): Dimension {
  return {
    type,
    onFailure,
    wave,
    // wave-executor doesn't read these; cast to satisfy TS.
  } as unknown as Dimension;
}

// ===== groupByWave =====

describe('workflows/wave-executor — groupByWave', () => {
  it('groups dims by their wave number', () => {
    const groups = groupByWave([
      dim('FUNDAMENTAL', 1),
      dim('VALUATION', 1),
      dim('RISK', 2),
      dim('PORTFOLIO', 3),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.wave).toBe(1);
    expect(groups[0]?.dims.map((d) => d.type)).toEqual([
      'FUNDAMENTAL',
      'VALUATION',
    ]);
    expect(groups[1]?.wave).toBe(2);
    expect(groups[2]?.wave).toBe(3);
  });

  it('treats wave === undefined as wave 1', () => {
    const groups = groupByWave([
      dim('FUNDAMENTAL'),
      dim('VALUATION'),
      dim('RISK', 2),
    ]);
    expect(groups[0]?.wave).toBe(1);
    expect(groups[0]?.dims).toHaveLength(2);
    expect(groups[1]?.wave).toBe(2);
    expect(groups[1]?.dims).toHaveLength(1);
  });

  it('omits empty waves (no entry for wave 2 when nobody is in it)', () => {
    const groups = groupByWave([dim('FUNDAMENTAL', 1), dim('PORTFOLIO', 3)]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.wave).toBe(1);
    expect(groups[1]?.wave).toBe(3); // wave 2 skipped
  });

  it('preserves dim order within a wave', () => {
    const groups = groupByWave([
      dim('SENTIMENT', 1),
      dim('FUNDAMENTAL', 1),
      dim('VALUATION', 1),
    ]);
    expect(groups[0]?.dims.map((d) => d.type)).toEqual([
      'SENTIMENT',
      'FUNDAMENTAL',
      'VALUATION',
    ]);
  });

  it('returns empty array when no dims provided', () => {
    expect(groupByWave([])).toEqual([]);
  });
});

// ===== runWithSemaphore =====

describe('workflows/wave-executor — runWithSemaphore', () => {
  it('runs all tasks and returns results in input order', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ];
    const results = await runWithSemaphore(tasks, 2);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual(
      ['a', 'b', 'c'],
    );
  });

  it('caps concurrency at `limit`', async () => {
    let live = 0;
    let peak = 0;
    const makeTask = () => async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return live;
    };
    await runWithSemaphore(
      Array.from({ length: 10 }, () => makeTask()),
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it('captures rejections in PromiseSettledResult.rejected', async () => {
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve(3),
    ];
    const results = await runWithSemaphore(tasks, 2);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    expect(results[2]?.status).toBe('fulfilled');
  });

  it('continues past a rejection (does not short-circuit the batch)', async () => {
    let bRan = false;
    const tasks = [
      () => Promise.reject(new Error('a')),
      async () => {
        bRan = true;
        return 'b';
      },
    ];
    await runWithSemaphore(tasks, 1);
    expect(bRan).toBe(true);
  });

  it('limit < 1 coerces to 1', async () => {
    const order: number[] = [];
    const tasks = [0, 1, 2].map((i) => async () => {
      order.push(i);
      return i;
    });
    await runWithSemaphore(tasks, 0);
    // Strict serial order is what limit=1 enforces; coercion shouldn't
    // accidentally produce out-of-order interleaving.
    expect(order).toEqual([0, 1, 2]);
  });

  it('limit > tasks.length runs all in parallel without crashing', async () => {
    const results = await runWithSemaphore(
      [() => Promise.resolve(1), () => Promise.resolve(2)],
      100,
    );
    expect(results.length).toBe(2);
  });

  it('empty task list returns []', async () => {
    expect(await runWithSemaphore([], 4)).toEqual([]);
  });
});

// ===== findFailRunOffenders =====

describe('workflows/wave-executor — findFailRunOffenders', () => {
  it('returns dims with onFailure === "fail-run" that landed in failedTypes', () => {
    const dims = [
      dim('FUNDAMENTAL', 1, 'fail-run'),
      dim('VALUATION', 1, 'skip'),
      dim('RISK', 1, 'fail-run'),
    ];
    const failed = new Set<AnalysisType>(['FUNDAMENTAL', 'VALUATION']);
    const offenders = findFailRunOffenders(dims, failed);
    expect(offenders.map((d) => d.type)).toEqual(['FUNDAMENTAL']);
    // VALUATION is in failed but its onFailure=skip → not an offender.
  });

  it('returns empty when no fail-run dim failed', () => {
    const dims = [
      dim('FUNDAMENTAL', 1, 'fail-run'),
      dim('VALUATION', 1, 'skip'),
    ];
    expect(findFailRunOffenders(dims, new Set(['VALUATION']))).toEqual([]);
  });

  it('returns empty when no dim is fail-run', () => {
    const dims = [
      dim('FUNDAMENTAL', 1, 'skip'),
      dim('VALUATION', 1, 'retry-once'),
    ];
    expect(
      findFailRunOffenders(dims, new Set(['FUNDAMENTAL', 'VALUATION'])),
    ).toEqual([]);
  });
});
