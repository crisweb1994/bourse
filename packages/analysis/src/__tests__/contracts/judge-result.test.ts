import { describe, expect, it } from 'vitest';
import { JudgeResult } from '../../contracts/judge-result';

describe('contracts/JudgeResult (RFC-10 P1)', () => {
  it('parses a minimal pass=true result', () => {
    const parsed = JudgeResult.parse({
      schemaVersion: 'judge-result-v1',
      pass: true,
      concerns: [],
      suggestedRevisions: [],
      confidenceAdjustment: 'KEEP',
    });
    expect(parsed.pass).toBe(true);
    expect(parsed.confidenceAdjustment).toBe('KEEP');
  });

  it('parses a fail result with concerns + downgrade', () => {
    const parsed = JudgeResult.parse({
      schemaVersion: 'judge-result-v1',
      pass: false,
      concerns: [
        'PE assumes 30x but peerPE p50 is 18x — strong claim unsupported',
        'No EvidencePack citation for the "moat widening" assertion',
      ],
      suggestedRevisions: ['Cite peer PE distribution; revise to MEDIUM'],
      confidenceAdjustment: 'DOWNGRADE_TO_MEDIUM',
    });
    expect(parsed.pass).toBe(false);
    expect(parsed.concerns).toHaveLength(2);
    expect(parsed.confidenceAdjustment).toBe('DOWNGRADE_TO_MEDIUM');
  });

  it('rejects an UPGRADE confidenceAdjustment (RFC-10 prompt-injection guard)', () => {
    const r = JudgeResult.safeParse({
      schemaVersion: 'judge-result-v1',
      pass: true,
      concerns: [],
      suggestedRevisions: [],
      confidenceAdjustment: 'UPGRADE_TO_HIGH',
    });
    expect(r.success).toBe(false);
  });

  it('rejects wrong schemaVersion', () => {
    const r = JudgeResult.safeParse({
      schemaVersion: 'judge-result-v2',
      pass: true,
      concerns: [],
      suggestedRevisions: [],
      confidenceAdjustment: 'KEEP',
    });
    expect(r.success).toBe(false);
  });

  it('rejects >8 concerns', () => {
    const r = JudgeResult.safeParse({
      schemaVersion: 'judge-result-v1',
      pass: false,
      concerns: Array(9).fill('c'),
      suggestedRevisions: [],
      confidenceAdjustment: 'DOWNGRADE_TO_LOW',
    });
    expect(r.success).toBe(false);
  });

  it('rejects >5 suggestedRevisions', () => {
    const r = JudgeResult.safeParse({
      schemaVersion: 'judge-result-v1',
      pass: false,
      concerns: ['c1'],
      suggestedRevisions: Array(6).fill('s'),
      confidenceAdjustment: 'DOWNGRADE_TO_LOW',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty-string concerns (no padding allowed)', () => {
    const r = JudgeResult.safeParse({
      schemaVersion: 'judge-result-v1',
      pass: false,
      concerns: [''],
      suggestedRevisions: [],
      confidenceAdjustment: 'DOWNGRADE_TO_LOW',
    });
    expect(r.success).toBe(false);
  });
});
