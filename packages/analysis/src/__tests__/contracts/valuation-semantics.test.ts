import { describe, expect, it } from 'vitest';
import {
  SectionResult,
  hasComputedValuationFact,
  validateValuationSemantics,
  degradeValuationSemantics,
} from '../../contracts/analysis-result';

function valuationResult(overrides: {
  scenarios?: Array<{ case: 'BEAR' | 'BASE' | 'BULL'; valueRange?: { low: number; high: number; currency: string } | null }>;
  methods?: Array<{ name: string; rationale: string; inputs: unknown[] }>;
  assessment?: string;
} = {}): SectionResult {
  return {
    schemaVersion: 'analysis-section-v2',
    type: 'VALUATION_SCENARIOS',
    assessment: (overrides.assessment ?? 'FAIR') as never,
    confidence: 'MEDIUM',
    summary: 'summary',
    findings: [],
    limitations: [],
    dataAsOf: '2026-08-15',
    disclaimer: 'd',
    methods: (overrides.methods ?? [{ name: 'PE 分位', rationale: 'r', inputs: [] }]) as never,
    scenarios: (overrides.scenarios ?? [
      { case: 'BASE', assumptions: ['a'], valueRange: { low: 10, high: 20, currency: 'USD' }, invalidators: [] },
      { case: 'BEAR', assumptions: ['a'], valueRange: null, invalidators: [] },
    ]) as never,
  } as SectionResult;
}

describe('hasComputedValuationFact — shared predicate (R-4)', () => {
  it('true only when valuation carries a code-computed fair value (P0 fix)', () => {
    expect(hasComputedValuationFact(null)).toBe(false);
    expect(hasComputedValuationFact(undefined)).toBe(false);
    expect(hasComputedValuationFact({ valuation: null })).toBe(false);
    // P0 回归锁：valuation 对象存在但没有公允价值（如仅 marketCap）→ false，
    // 否则模型编造的区间会被标注"代码计算"（review 2026-08-16）
    expect(hasComputedValuationFact({ valuation: { pe5yMedian: 1 } })).toBe(false);
    expect(hasComputedValuationFact({ valuation: { marketCap: 1e12 } })).toBe(false);
    expect(
      hasComputedValuationFact({ valuation: { fairValuePerShare: 246.2 } }),
    ).toBe(true);
  });
});

describe('validateValuationSemantics — post-chain validator (§四.④)', () => {
  it('passes a well-formed result', () => {
    const v = validateValuationSemantics(valuationResult(), true);
    expect(v.ok).toBe(true);
    expect(v.gaps).toEqual([]);
  });

  it('F14 regression: empty scenarios + empty methods both flagged', () => {
    const r = valuationResult({ scenarios: [], methods: [] });
    const v = validateValuationSemantics(r, true);
    expect(v.ok).toBe(false);
    expect(v.gaps.join(' ')).toContain('scenarios 为空');
    expect(v.gaps.join(' ')).toContain('methods 为空');
  });

  it('flags duplicate cases', () => {
    const r = valuationResult({
      scenarios: [
        { case: 'BASE', valueRange: { low: 1, high: 2, currency: 'USD' } },
        { case: 'BASE', valueRange: { low: 3, high: 4, currency: 'USD' } },
      ],
    });
    const v = validateValuationSemantics(r, true);
    expect(v.ok).toBe(false);
    expect(v.gaps.join(' ')).toContain('case 重复');
  });

  it('flags missing BASE and single-case coverage', () => {
    const r = valuationResult({
      scenarios: [{ case: 'BULL', valueRange: { low: 1, high: 2, currency: 'USD' } }],
    });
    const v = validateValuationSemantics(r, true);
    expect(v.gaps.join(' ')).toContain('缺少 BASE');
    expect(v.gaps.join(' ')).toContain('至少需要 2 个不同 case');
  });

  it('computed valuation present but every valueRange null → gap (A2 rule)', () => {
    const r = valuationResult({
      scenarios: [
        { case: 'BASE', valueRange: null },
        { case: 'BEAR', valueRange: null },
      ],
    });
    const v = validateValuationSemantics(r, true);
    expect(v.ok).toBe(false);
    expect(v.gaps.join(' ')).toContain('valueRange');
  });

  it('all-null ranges are legal when no computed valuation exists', () => {
    const r = valuationResult({
      scenarios: [
        { case: 'BASE', valueRange: null },
        { case: 'BEAR', valueRange: null },
      ],
    });
    expect(validateValuationSemantics(r, false).ok).toBe(true);
  });

  it('skips requirements when module declared UNASSESSABLE (legitimate degradation)', () => {
    const r = valuationResult({ scenarios: [], methods: [], assessment: 'UNASSESSABLE' });
    expect(validateValuationSemantics(r, true).ok).toBe(true);
  });

  it('non-valuation sections pass through', () => {
    expect(validateValuationSemantics({ type: 'RISK_REGISTER' } as SectionResult, true).ok).toBe(true);
  });
});

describe('degradeValuationSemantics — degrade exit keeps legal subset (§四.④ layer 3)', () => {
  it('dedupes duplicate cases and records the gap as a limitation', () => {
    const r = valuationResult({
      scenarios: [
        { case: 'BASE', valueRange: { low: 1, high: 2, currency: 'USD' } },
        { case: 'BASE', valueRange: { low: 3, high: 4, currency: 'USD' } },
      ],
    });
    const degraded = degradeValuationSemantics(r, ['case 重复', '缺少 BEAR']);
    const v = degraded as unknown as { scenarios: unknown[]; limitations: string[] };
    expect(v.scenarios).toHaveLength(1);
    expect(v.limitations.at(-1)).toContain('情景区间不完整');
    expect(v.limitations.at(-1)).toContain('case 重复');
    expect(v.limitations.at(-1)).toContain('缺少 BEAR');
  });

  it('never fabricates scenarios when the subset is empty', () => {
    const r = valuationResult({ scenarios: [] });
    const degraded = degradeValuationSemantics(r, ['scenarios 为空']);
    expect((degraded as unknown as { scenarios: unknown[] }).scenarios).toHaveLength(0);
    expect((degraded as unknown as { limitations: string[] }).limitations.at(-1)).toContain('scenarios 为空');
  });
});
