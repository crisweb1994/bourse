import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedTaskQueue } from './bounded-task-queue';

test('deduplicates tasks and respects the concurrency limit', async () => {
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  let releaseFirst!: () => void;
  let finishLast!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const lastFinished = new Promise<void>((resolve) => {
    finishLast = resolve;
  });

  const queue = new BoundedTaskQueue<string>({
    concurrency: 2,
    execute: async (task) => {
      started.push(task);
      active += 1;
      peak = Math.max(peak, active);
      if (task === 'first') await firstBlocked;
      active -= 1;
      if (task === 'last') finishLast();
    },
  });

  queue.schedule('first');
  queue.schedule('first');
  queue.schedule('middle');
  queue.schedule('last');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(started, ['first', 'middle']);
  assert.equal(peak, 2);

  releaseFirst();
  await lastFinished;
  assert.deepEqual(started, ['first', 'middle', 'last']);
});

test('releases a rejected task so later work can run', async () => {
  const started: string[] = [];
  let finishLast!: () => void;
  const lastFinished = new Promise<void>((resolve) => {
    finishLast = resolve;
  });

  const queue = new BoundedTaskQueue<string>({
    concurrency: 1,
    execute: async (task) => {
      started.push(task);
      if (task === 'failed') throw new Error('expected test failure');
      finishLast();
    },
  });

  queue.schedule('failed');
  queue.schedule('last');
  await lastFinished;
  assert.deepEqual(started, ['failed', 'last']);
});
