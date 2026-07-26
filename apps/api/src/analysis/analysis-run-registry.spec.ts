import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisRunRegistry } from './analysis-run-registry.service';

describe('AnalysisRunRegistry', () => {
  it('register + abort triggers the controller', () => {
    const registry = new AnalysisRunRegistry();
    const ac = new AbortController();
    registry.register('a1', ac);

    assert.equal(registry.isRunning('a1'), true);
    assert.equal(ac.signal.aborted, false);

    const triggered = registry.abort('a1');
    assert.equal(triggered, true);
    assert.equal(ac.signal.aborted, true);
    assert.equal(registry.isRunning('a1'), false);
  });

  it('abort returns false when id is not registered', () => {
    const registry = new AnalysisRunRegistry();
    assert.equal(registry.abort('unknown'), false);
    assert.equal(registry.isRunning('unknown'), false);
  });

  it('abort is idempotent — second call returns false', () => {
    const registry = new AnalysisRunRegistry();
    const ac = new AbortController();
    registry.register('a1', ac);

    assert.equal(registry.abort('a1'), true);
    assert.equal(registry.abort('a1'), false);
  });

  it('release unregisters the controller', () => {
    const registry = new AnalysisRunRegistry();
    const ac = new AbortController();
    registry.register('a1', ac);

    registry.release('a1');
    assert.equal(registry.isRunning('a1'), false);
    assert.equal(registry.abort('a1'), false);
  });

  it('isRunning is false for a controller that has already aborted', () => {
    const registry = new AnalysisRunRegistry();
    const ac = new AbortController();
    registry.register('a1', ac);
    ac.abort();

    assert.equal(registry.isRunning('a1'), false);
  });
});
