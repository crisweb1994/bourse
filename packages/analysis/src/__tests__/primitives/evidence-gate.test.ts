import { describe, expect, it } from 'vitest';
import type { StructuredJson } from '../../contracts/analysis-result';
import {
  applyEvidenceGate,
  inferDomainTier,
} from '../../primitives/evidence-gate';
import type { DomainTier } from '../../markets/types';

const baseJson = (overrides: Partial<StructuredJson>): StructuredJson => ({
  schemaVersion: 'agent-result-v1',
  conclusion: {
    signal: 'NEUTRAL',
    confidence: 'MEDIUM',
    oneLiner: '占位 oneLiner，10-50 个汉字之间。',
    evidence: [],
  },
  evidence: [],
  dataAvailability: { missingFields: [], reason: 'ok' },
  dataAsOf: '2026-05-10',
  disclaimer: '占位免责声明',
  ...overrides,
});

const c = (
  url: string,
  tier: 'A' | 'B' | 'C' | 'D' | 'E' | undefined,
): {
  title: string;
  url: string;
  sourceType: 'OTHER';
  retrievedAt: string;
  qualityTier?: 'A' | 'B' | 'C' | 'D' | 'E';
} => ({
  title: 't',
  url,
  sourceType: 'OTHER',
  retrievedAt: '2026-05-10T00:00:00Z',
  ...(tier ? { qualityTier: tier } : {}),
});

describe('applyEvidenceGate — rule 1 (E-only claim removal)', () => {
  it('removes claims whose citations are all tier E', () => {
    const data = baseJson({
      evidence: [
        { claim: 'good claim', citations: [c('https://a', 'A')] },
        { claim: 'bad claim', citations: [c('https://b', 'E'), c('https://c', 'E')] },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.data.evidence).toHaveLength(1);
    expect(r.data.evidence[0]!.claim).toBe('good claim');
    expect(r.warnings.some((w) => w.includes('E-only claim removed'))).toBe(true);
  });

  it('treats missing qualityTier as tier E', () => {
    const data = baseJson({
      evidence: [
        { claim: 'untiered', citations: [c('https://a', undefined)] },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.data.evidence).toHaveLength(0);
    expect(r.noEvidence).toBe(true);
  });

  it('keeps claim when at least one citation is non-E', () => {
    const data = baseJson({
      evidence: [
        {
          claim: 'mixed',
          citations: [c('https://e', 'E'), c('https://c', 'C')],
        },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.data.evidence).toHaveLength(1);
    expect(r.noEvidence).toBe(false);
  });

  it('does not flag noEvidence when no claims were removed', () => {
    const data = baseJson({
      evidence: [
        { claim: 'good', citations: [c('https://a', 'A')] },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.noEvidence).toBe(false);
  });
});

describe('applyEvidenceGate — rule 2 (AB soft check)', () => {
  it('warns when BULLISH + AB ratio < 50%', () => {
    const data = baseJson({
      conclusion: {
        signal: 'BULLISH',
        confidence: 'MEDIUM',
        oneLiner: 'lor lor lor lor lor lor lor lor lor',
        evidence: [],
      },
      evidence: [
        {
          claim: 'mixed',
          citations: [c('https://a', 'A'), c('https://b', 'C'), c('https://d', 'C')],
        },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.warnings.some((w) => w.includes('A/B 级证据占比偏低'))).toBe(true);
  });

  it('no warning when AB ratio >= 50%', () => {
    const data = baseJson({
      conclusion: {
        signal: 'BULLISH',
        confidence: 'MEDIUM',
        oneLiner: 'lor lor lor lor lor lor lor lor lor',
        evidence: [],
      },
      evidence: [
        {
          claim: 'high quality',
          citations: [c('https://a', 'A'), c('https://b', 'B')],
        },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.warnings.some((w) => w.includes('A/B 级证据占比偏低'))).toBe(false);
  });

  it('no warning when signal is not BULLISH', () => {
    const data = baseJson({
      conclusion: {
        signal: 'NEUTRAL',
        confidence: 'MEDIUM',
        oneLiner: 'lor lor lor lor lor lor lor lor lor',
        evidence: [],
      },
      evidence: [
        { claim: 'x', citations: [c('https://a', 'C')] },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.warnings.some((w) => w.includes('A/B'))).toBe(false);
  });
});

// ===== RFC-06 Rule 0: domain-tier downgrade =====

describe('inferDomainTier (RFC-06)', () => {
  const tiers: Record<string, DomainTier> = {
    'cninfo.com.cn': 'A',
    'eastmoney.com': 'B',
    'xueqiu.com': 'D',
  };

  it('matches the exact hostname', () => {
    expect(inferDomainTier('https://cninfo.com.cn/foo', tiers)).toBe('A');
    expect(inferDomainTier('https://eastmoney.com/x', tiers)).toBe('B');
  });

  it('strips the leading www.', () => {
    expect(inferDomainTier('https://www.cninfo.com.cn/', tiers)).toBe('A');
  });

  it('walks parent domains for subdomains', () => {
    expect(inferDomainTier('https://static.cninfo.com.cn/img', tiers)).toBe('A');
    expect(
      inferDomainTier('https://reportapi.eastmoney.com/report/list', tiers),
    ).toBe('B');
  });

  it('returns null for unknown hosts', () => {
    expect(inferDomainTier('https://random-blog.example/x', tiers)).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(inferDomainTier('not-a-url', tiers)).toBeNull();
  });

  it('returns null when domainTiers is undefined', () => {
    expect(inferDomainTier('https://cninfo.com.cn', undefined)).toBeNull();
  });
});

describe('applyEvidenceGate — rule 0 (RFC-06 domain-tier downgrade)', () => {
  const tiers: Record<string, DomainTier> = {
    'cninfo.com.cn': 'A',
    'eastmoney.com': 'B',
    'sina.com.cn': 'C',
    'xueqiu.com': 'D',
  };

  it('downgrades LLM-declared A → D when host is actually tier D', () => {
    const data = baseJson({
      evidence: [
        {
          claim: 'over-claimed',
          citations: [c('https://xueqiu.com/post', 'A')],
        },
      ],
    });
    const r = applyEvidenceGate(data, { domainTiers: tiers });
    expect(r.data.evidence[0]!.citations[0]!.qualityTier).toBe('D');
    expect(
      r.warnings.some((w) =>
        w.includes('LLM declared A, code-side D'),
      ),
    ).toBe(true);
  });

  it('does NOT change LLM-declared tier when it matches code-side', () => {
    const data = baseJson({
      evidence: [
        {
          claim: 'honest',
          citations: [c('https://cninfo.com.cn/x', 'A')],
        },
      ],
    });
    const r = applyEvidenceGate(data, { domainTiers: tiers });
    expect(r.data.evidence[0]!.citations[0]!.qualityTier).toBe('A');
    expect(r.warnings.filter((w) => w.includes('downgraded'))).toHaveLength(0);
  });

  it('does NOT change LLM-declared tier when it is LOWER than code-side', () => {
    // LLM says D for a tier-A domain — humility is rewarded, no upgrade.
    const data = baseJson({
      evidence: [
        {
          claim: 'humble',
          citations: [c('https://cninfo.com.cn/x', 'D')],
        },
      ],
    });
    const r = applyEvidenceGate(data, { domainTiers: tiers });
    expect(r.data.evidence[0]!.citations[0]!.qualityTier).toBe('D');
  });

  it('uses parent-domain match for subdomains', () => {
    const data = baseJson({
      evidence: [
        {
          claim: 'sub',
          citations: [c('https://static.cninfo.com.cn/foo', 'B')],
        },
      ],
    });
    const r = applyEvidenceGate(data, { domainTiers: tiers });
    // static.cninfo.com.cn → cninfo.com.cn → A. LLM declared B (lower); honor LLM.
    expect(r.data.evidence[0]!.citations[0]!.qualityTier).toBe('B');

    const upgraded = baseJson({
      evidence: [
        {
          claim: 'sub-upgrade',
          citations: [c('https://reportapi.eastmoney.com/report', 'A')],
        },
      ],
    });
    const r2 = applyEvidenceGate(upgraded, { domainTiers: tiers });
    // reportapi.eastmoney.com → eastmoney.com → B. LLM declared A → downgrade.
    expect(r2.data.evidence[0]!.citations[0]!.qualityTier).toBe('B');
  });

  it('skips untiered citations (backward compat)', () => {
    const data = baseJson({
      evidence: [
        {
          claim: 'no tier',
          citations: [c('https://xueqiu.com/post', undefined)],
        },
      ],
    });
    const r = applyEvidenceGate(data, { domainTiers: tiers });
    // Rule 0 leaves it; Rule 1 treats missing as E and removes the claim.
    expect(r.data.evidence).toHaveLength(0);
    expect(
      r.warnings.some((w) => w.includes('downgraded')),
    ).toBe(false);
  });

  it('does nothing when domainTiers option is omitted (legacy behavior)', () => {
    const data = baseJson({
      evidence: [
        {
          claim: 'over-claimed',
          citations: [c('https://xueqiu.com/post', 'A')],
        },
      ],
    });
    const r = applyEvidenceGate(data); // no options
    expect(r.data.evidence[0]!.citations[0]!.qualityTier).toBe('A');
  });

  it('feeds downgraded tiers into Rule 1 so D→E-equivalent removal still triggers', () => {
    // Build a citation table where the host is mapped to E (intentional
    // denylist). LLM claimed C; Rule 0 downgrades to E; Rule 1 then
    // removes the now-E-only claim.
    const denylist: Record<string, DomainTier> = { 'badblog.example': 'E' };
    const data = baseJson({
      evidence: [
        {
          claim: 'sketchy',
          citations: [c('https://badblog.example/x', 'C')],
        },
      ],
    });
    const r = applyEvidenceGate(data, { domainTiers: denylist });
    expect(r.data.evidence).toHaveLength(0);
    expect(r.noEvidence).toBe(true);
    expect(
      r.warnings.some((w) => w.includes('LLM declared C, code-side E')),
    ).toBe(true);
    expect(r.warnings.some((w) => w.includes('E-only claim removed'))).toBe(
      true,
    );
  });
});

describe('applyEvidenceGate — rule 3 (AB hard check)', () => {
  it('downgrades confidence HIGH → MEDIUM when BULLISH+BUY+AB<30%', () => {
    const data = baseJson({
      conclusion: {
        signal: 'BULLISH',
        confidence: 'HIGH',
        oneLiner: 'lor lor lor lor lor lor lor lor lor',
        evidence: [],
      },
      recommendation: 'BUY',
      evidence: [
        {
          claim: 'low quality',
          citations: [
            c('https://a', 'C'),
            c('https://b', 'C'),
            c('https://c', 'D'),
            c('https://d', 'D'),
          ],
        },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.data.conclusion.confidence).toBe('MEDIUM');
    expect(r.warnings.some((w) => w.includes('强制从 HIGH 降为 MEDIUM'))).toBe(true);
  });

  it('does not downgrade when AB ratio >= 30%', () => {
    const data = baseJson({
      conclusion: {
        signal: 'BULLISH',
        confidence: 'HIGH',
        oneLiner: 'lor lor lor lor lor lor lor lor lor',
        evidence: [],
      },
      recommendation: 'BUY',
      evidence: [
        {
          claim: 'mixed',
          citations: [c('https://a', 'A'), c('https://b', 'C'), c('https://d', 'C')],
        },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.data.conclusion.confidence).toBe('HIGH');
  });

  it('does not downgrade when recommendation is not BUY', () => {
    const data = baseJson({
      conclusion: {
        signal: 'BULLISH',
        confidence: 'HIGH',
        oneLiner: 'lor lor lor lor lor lor lor lor lor',
        evidence: [],
      },
      recommendation: 'HOLD',
      evidence: [
        { claim: 'low', citations: [c('https://a', 'D'), c('https://b', 'D')] },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.data.conclusion.confidence).toBe('HIGH');
  });

  it('does not change MEDIUM/LOW confidence (only HIGH downgraded)', () => {
    const data = baseJson({
      conclusion: {
        signal: 'BULLISH',
        confidence: 'MEDIUM',
        oneLiner: 'lor lor lor lor lor lor lor lor lor',
        evidence: [],
      },
      recommendation: 'BUY',
      evidence: [
        { claim: 'low', citations: [c('https://a', 'D')] },
      ],
    });
    const r = applyEvidenceGate(data);
    expect(r.data.conclusion.confidence).toBe('MEDIUM');
  });
});

describe('applyEvidenceGate — rule 4 (RFC financials Phase 1 required fact references)', () => {
  it('soft-warns when required fact key is absent from factReferences', () => {
    const data = baseJson({
      evidence: [
        { claim: 'something', citations: [c('https://a', 'A')] },
      ],
      factReferences: ['quote', 'pe'],
    });
    const r = applyEvidenceGate(data, { requiredFactReferences: ['financials'] });
    expect(r.warnings.some((w) => w.includes('factReferences missing required key "financials"'))).toBe(true);
    // No mutation — evidence array intact.
    expect(r.data.evidence).toHaveLength(1);
    expect(r.data.factReferences).toEqual(['quote', 'pe']);
  });

  it('no warning when required key is present', () => {
    const data = baseJson({
      evidence: [
        { claim: 'something', citations: [c('https://a', 'A')] },
      ],
      factReferences: ['financials', 'quote'],
    });
    const r = applyEvidenceGate(data, { requiredFactReferences: ['financials'] });
    expect(r.warnings.some((w) => w.includes('factReferences missing'))).toBe(false);
  });

  it('treats undefined factReferences as empty (warns)', () => {
    const data = baseJson({
      evidence: [
        { claim: 'something', citations: [c('https://a', 'A')] },
      ],
      // factReferences intentionally omitted
    });
    const r = applyEvidenceGate(data, { requiredFactReferences: ['financials'] });
    expect(r.warnings.some((w) => w.includes('factReferences missing required key "financials"'))).toBe(true);
  });

  it('skips rule when requiredFactReferences option is omitted', () => {
    const data = baseJson({
      evidence: [
        { claim: 'something', citations: [c('https://a', 'A')] },
      ],
      // factReferences also omitted
    });
    const r = applyEvidenceGate(data);
    expect(r.warnings.some((w) => w.includes('factReferences missing'))).toBe(false);
  });

  it('warns once per missing required key', () => {
    const data = baseJson({
      evidence: [
        { claim: 'something', citations: [c('https://a', 'A')] },
      ],
      factReferences: ['quote'],
    });
    const r = applyEvidenceGate(data, {
      requiredFactReferences: ['financials', 'consensusEps'],
    });
    expect(r.warnings.filter((w) => w.includes('factReferences missing required key')).length).toBe(2);
  });
});
