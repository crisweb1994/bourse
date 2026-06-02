import { describe, expect, it } from 'vitest';
import { classifyFallback } from '../../primitives/fallback-classifier';

describe('classifyFallback', () => {
  it('rejects TRANSIENT errors via structured kind', () => {
    const d = classifyFallback({ kind: 'TRANSIENT', message: 'timeout' });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reason).toBe('TRANSIENT');
  });

  it('rejects INPUT_INVALID', () => {
    const d = classifyFallback({ kind: 'INPUT_INVALID', message: 'bad symbol' });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reason).toBe('INPUT_INVALID');
  });

  it('AUTH structured → eligible AUTH', () => {
    const d = classifyFallback({
      kind: 'AUTH',
      message: '401',
      failedTools: ['consensusEpsCN'],
    });
    expect(d.eligible).toBe(true);
    if (d.eligible) {
      expect(d.kind).toBe('AUTH');
      expect(d.failedTools).toEqual(['consensusEpsCN']);
    }
  });

  it('message pattern: 401 → AUTH', () => {
    const d = classifyFallback(new Error('Request failed with 401 Unauthorized'));
    expect(d.eligible).toBe(true);
    if (d.eligible) expect(d.kind).toBe('AUTH');
  });

  it('message pattern: ENOTFOUND → NETWORK', () => {
    const d = classifyFallback(new Error('getaddrinfo ENOTFOUND tushare.pro'));
    expect(d.eligible).toBe(true);
    if (d.eligible) expect(d.kind).toBe('NETWORK');
  });

  it('message pattern: quota → RATE_LIMIT_HARD', () => {
    const d = classifyFallback(new Error('account quota exhausted'));
    expect(d.eligible).toBe(true);
    if (d.eligible) expect(d.kind).toBe('RATE_LIMIT_HARD');
  });

  it('message pattern: symbol not found → INPUT_INVALID rejected', () => {
    const d = classifyFallback(new Error('symbol XXX.SS not found'));
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reason).toBe('INPUT_INVALID');
  });

  it('message pattern: timeout → TRANSIENT rejected', () => {
    const d = classifyFallback(new Error('Request timeout after 30s'));
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reason).toBe('TRANSIENT');
  });

  it('unrecognized error → OTHER eligible', () => {
    const d = classifyFallback(new Error('something weird'));
    expect(d.eligible).toBe(true);
    if (d.eligible) expect(d.kind).toBe('OTHER');
  });
});
