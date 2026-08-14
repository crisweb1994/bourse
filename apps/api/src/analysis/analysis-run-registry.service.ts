import { Injectable } from '@nestjs/common';
import type { AnalysisSseCallback, AnalysisSseEventName } from './analysis-sse.contract';

interface ActiveRun {
  controller: AbortController;
  subscribers: Set<AnalysisSseCallback>;
  done: Promise<void>;
  resolveDone: () => void;
}

@Injectable()
export class AnalysisRunRegistry {
  private readonly runs = new Map<string, ActiveRun>();

  register(id: string, controller: AbortController): void {
    if (this.runs.has(id)) return;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.runs.set(id, {
      controller,
      subscribers: new Set(),
      done,
      resolveDone,
    });
  }

  subscribe(id: string, callback: AnalysisSseCallback): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    run.subscribers.add(callback);
    return true;
  }

  unsubscribe(id: string, callback: AnalysisSseCallback): void {
    this.runs.get(id)?.subscribers.delete(callback);
  }

  broadcast(
    id: string,
    event: AnalysisSseEventName,
    data: unknown,
  ): void {
    const run = this.runs.get(id);
    if (!run) return;
    for (const subscriber of run.subscribers) {
      subscriber(event as never, data as never);
    }
  }

  async wait(id: string): Promise<void> {
    await this.runs.get(id)?.done;
  }

  release(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.resolveDone();
    this.runs.delete(id);
  }

  abort(id: string): boolean {
    const controller = this.runs.get(id)?.controller;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  isRunning(id: string): boolean {
    const run = this.runs.get(id);
    return Boolean(run && !run.controller.signal.aborted);
  }
}
