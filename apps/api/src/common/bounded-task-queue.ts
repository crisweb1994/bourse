export interface BoundedTaskQueueOptions<T extends string> {
  concurrency: number;
  execute: (task: T) => Promise<void>;
}

/**
 * Small in-process queue for persisted work items.
 *
 * The queue only owns scheduling concerns. Claiming, retries, and persistence
 * remain in the caller so different run types can share this mechanism without
 * sharing their state machines.
 */
export class BoundedTaskQueue<T extends string> {
  private readonly queued = new Set<T>();
  private readonly pending: T[] = [];
  private active = 0;

  constructor(private readonly options: BoundedTaskQueueOptions<T>) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('BoundedTaskQueue concurrency must be a positive integer');
    }
  }

  schedule(task: T): void {
    if (this.queued.has(task)) return;
    this.queued.add(task);
    this.pending.push(task);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.options.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) return;

      this.active += 1;
      setImmediate(() => {
        void Promise.resolve()
          .then(() => this.options.execute(task))
          .catch(() => undefined)
          .finally(() => {
            this.active -= 1;
            this.queued.delete(task);
            this.drain();
          });
      });
    }
  }
}
