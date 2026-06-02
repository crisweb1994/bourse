import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_PACK_V2_FACT_KEYS,
  EvidencePackV2,
  Fact,
  MinimalFacts,
  SourceTier,
} from '../../contracts/evidence-pack-v2';
import { EvidencePackAny } from '../../contracts/evidence-pack';
import { z } from 'zod';

// Helpers
const NOW = '2026-05-14T08:00:00.000Z';
const URL = 'https://cninfo.com.cn/foo';

function validFact<T>(value: T) {
  return {
    value,
    asOf: NOW,
    retrievedAt: NOW,
    sourceUrl: URL,
    sourceTier: 'A' as const,
  };
}

describe('Fact<T> helper', () => {
  it('accepts a valid provenance-wrapped value', () => {
    const schema = Fact(z.number());
    const r = schema.safeParse(validFact(123));
    expect(r.success).toBe(true);
  });

  it('rejects missing sourceUrl', () => {
    const schema = Fact(z.number());
    const r = schema.safeParse({ ...validFact(123), sourceUrl: undefined });
    expect(r.success).toBe(false);
  });

  it('rejects non-URL sourceUrl', () => {
    const schema = Fact(z.number());
    const r = schema.safeParse({ ...validFact(123), sourceUrl: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('rejects missing retrievedAt', () => {
    const schema = Fact(z.number());
    const r = schema.safeParse({ ...validFact(123), retrievedAt: undefined });
    expect(r.success).toBe(false);
  });

  it('accepts optional unit + currency', () => {
    const schema = Fact(z.number());
    const r = schema.safeParse({
      ...validFact(123),
      unit: '亿元',
      currency: 'CNY',
    });
    expect(r.success).toBe(true);
  });

  it('rejects sourceTier outside A-E', () => {
    const schema = Fact(z.number());
    const r = schema.safeParse({ ...validFact(123), sourceTier: 'F' });
    expect(r.success).toBe(false);
  });
});

describe('SourceTier enum', () => {
  it('accepts A/B/C/D/E', () => {
    for (const t of ['A', 'B', 'C', 'D', 'E']) {
      expect(SourceTier.safeParse(t).success).toBe(true);
    }
  });
  it('rejects anything else', () => {
    expect(SourceTier.safeParse('F').success).toBe(false);
    expect(SourceTier.safeParse('a').success).toBe(false);
  });
});

describe('MinimalFacts schema', () => {
  it('accepts empty (all optional)', () => {
    expect(MinimalFacts.safeParse({}).success).toBe(true);
  });

  it('accepts partial — only quote populated', () => {
    const r = MinimalFacts.safeParse({ quote: validFact(98.16) });
    expect(r.success).toBe(true);
  });

  it('rejects negative quote (must be positive)', () => {
    const r = MinimalFacts.safeParse({ quote: validFact(-1) });
    expect(r.success).toBe(false);
  });

  it('accepts currency only when 3 chars', () => {
    expect(
      MinimalFacts.safeParse({ currency: validFact('CNY') }).success,
    ).toBe(true);
    expect(
      MinimalFacts.safeParse({ currency: validFact('USD') }).success,
    ).toBe(true);
    expect(
      MinimalFacts.safeParse({ currency: validFact('YEN') }).success,
    ).toBe(true);
    // wrong length
    expect(
      MinimalFacts.safeParse({ currency: validFact('CN') }).success,
    ).toBe(false);
  });
});

describe('EvidencePackV2 envelope', () => {
  function minimalValidPack(): unknown {
    return {
      schemaVersion: 'evidence-pack-v2',
      symbol: '600519.SS',
      market: 'CN',
      capturedAt: NOW,
      facts: {},
      dataAvailability: {
        complete: [],
        missing: [],
        fallbacks: [],
      },
      citations: [],
      trace: {
        toolCalls: 0,
        durationMs: 0,
        costUsd: 0,
      },
    };
  }

  it('accepts a fully empty (but well-formed) pack', () => {
    const r = EvidencePackV2.safeParse(minimalValidPack());
    expect(r.success).toBe(true);
  });

  // v0.6 PRD §9.1 — market widened from CN-only to a closed enum so the
  // snapshot-backed wrapper can produce v2 packs for US/HK/JP/UK. CN keeps
  // working without behavioural change.
  it('accepts CN, US, HK, JP, UK markets', () => {
    for (const m of ['CN', 'US', 'HK', 'JP', 'UK'] as const) {
      const pack = minimalValidPack() as Record<string, unknown>;
      pack.market = m;
      expect(EvidencePackV2.safeParse(pack).success).toBe(true);
    }
  });

  it('rejects unknown market literal', () => {
    const pack = minimalValidPack() as Record<string, unknown>;
    pack.market = 'BANANA';
    const r = EvidencePackV2.safeParse(pack);
    expect(r.success).toBe(false);
  });

  it('rejects wrong schemaVersion literal', () => {
    const pack = minimalValidPack() as Record<string, unknown>;
    pack.schemaVersion = 'evidence-pack-v1';
    const r = EvidencePackV2.safeParse(pack);
    expect(r.success).toBe(false);
  });

  it('accepts a populated pack with mixed minimal + A-share facts', () => {
    const pack = minimalValidPack() as Record<string, unknown>;
    pack.facts = {
      quote: validFact(98.16),
      currency: validFact('CNY'),
      lhbAppearances: validFact([
        {
          date: '2026-05-10',
          reason: '换手率达到20%',
          topBuySeats: ['国泰君安上海江苏路'],
        },
      ]),
    };
    pack.dataAvailability = {
      complete: ['quote', 'currency', 'lhbAppearances'],
      missing: [
        { field: 'consensusEps', reason: 'rate_limited_after_retries' },
      ],
      fallbacks: [],
    };
    pack.trace = {
      toolCalls: 7,
      durationMs: 4520,
      costUsd: 0,
      cacheHits: 3,
      fallbacksTriggered: 1,
    };
    const r = EvidencePackV2.safeParse(pack);
    expect(r.success).toBe(true);
  });

  it('rejects shareholderConcentration with ratio > 1', () => {
    const pack = minimalValidPack() as Record<string, unknown>;
    pack.facts = {
      shareholderConcentration: validFact({ top10Ratio: 1.5 }),
    };
    const r = EvidencePackV2.safeParse(pack);
    expect(r.success).toBe(false);
  });

  it('accepts shareholderConcentration with reasonable distribution', () => {
    const pack = minimalValidPack() as Record<string, unknown>;
    pack.facts = {
      shareholderConcentration: validFact({
        top10Ratio: 0.62,
        institutionRatio: 0.18,
        northboundRatio: 0.04,
        retailRatio: 0.16,
      }),
    };
    const r = EvidencePackV2.safeParse(pack);
    expect(r.success).toBe(true);
  });
});

describe('EvidencePackAny discriminated union', () => {
  function v1Pack(): unknown {
    return {
      schemaVersion: 'evidence-pack-v1',
      symbol: '600519.SS',
      market: 'CN',
      capturedAt: NOW,
      financialSnapshot: {},
      news: [],
      valuation: {},
      riskFacts: ['具体风险1'],
      allowedUrls: ['https://example.com'],
    };
  }
  function v2Pack(): unknown {
    return {
      schemaVersion: 'evidence-pack-v2',
      symbol: '600519.SS',
      market: 'CN',
      capturedAt: NOW,
      facts: {},
      dataAvailability: { complete: [], missing: [], fallbacks: [] },
      citations: [],
      trace: { toolCalls: 0, durationMs: 0, costUsd: 0 },
    };
  }

  it('accepts a valid v1 pack', () => {
    expect(EvidencePackAny.safeParse(v1Pack()).success).toBe(true);
  });

  it('accepts a valid v2 pack', () => {
    expect(EvidencePackAny.safeParse(v2Pack()).success).toBe(true);
  });

  it('rejects an unknown schemaVersion', () => {
    const bogus = v2Pack() as Record<string, unknown>;
    bogus.schemaVersion = 'evidence-pack-v3';
    expect(EvidencePackAny.safeParse(bogus).success).toBe(false);
  });

  it('routes parse to the right variant by schemaVersion', () => {
    const r1 = EvidencePackAny.safeParse(v1Pack());
    expect(r1.success).toBe(true);
    if (r1.success) {
      expect(r1.data.schemaVersion).toBe('evidence-pack-v1');
      // v1-specific field
      expect('financialSnapshot' in r1.data).toBe(true);
    }

    const r2 = EvidencePackAny.safeParse(v2Pack());
    expect(r2.success).toBe(true);
    if (r2.success) {
      expect(r2.data.schemaVersion).toBe('evidence-pack-v2');
      expect('dataAvailability' in r2.data).toBe(true);
    }
  });
});

describe('EVIDENCE_PACK_V2_FACT_KEYS', () => {
  it('lists all 13 fact field names', () => {
    expect(EVIDENCE_PACK_V2_FACT_KEYS).toHaveLength(13);
    // Sanity check a few representative keys
    expect(EVIDENCE_PACK_V2_FACT_KEYS).toContain('quote');
    expect(EVIDENCE_PACK_V2_FACT_KEYS).toContain('profile');
    expect(EVIDENCE_PACK_V2_FACT_KEYS).toContain('consensusEps');
    expect(EVIDENCE_PACK_V2_FACT_KEYS).toContain('shareholderConcentration');
  });
});
