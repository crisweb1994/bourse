import { describe, expect, it } from 'vitest';
import {
  EarningsNarrativeExtractionSchema,
  SupplementalFactCandidateSchema,
} from './earnings';

const validNarrative = {
  eventIdentityHints: {
    periodEndOn: '2025-12-31',
    periodType: 'FY',
  },
  guidance: [
    {
      metricCode: 'revenue',
      value: { kind: 'range', min: '100000', max: '110000' },
      unit: 'currency',
      currency: 'USD',
      scale: 1,
      targetPeriodEndOn: '2026-12-31',
      targetPeriodType: 'FY',
      accountingBasis: 'US-GAAP',
      consolidationScope: 'consolidated',
      sourceQuote: 'We expect revenue of $100-110 billion in 2026.',
    },
  ],
  managementClaims: [
    {
      text: 'We are accelerating investment in AI.',
      sourceQuote: 'We are accelerating investment in AI.',
    },
  ],
  supplementalNonGaapFacts: [
    {
      metricLabel: 'Non-GAAP EPS',
      value: { kind: 'scalar', value: '2.5' },
      unit: 'per_share',
      currency: 'USD',
      targetPeriodEndOn: '2025-12-31',
      sourceQuote: 'Non-GAAP diluted EPS was $2.50.',
      reconciliationContext: 'Excludes stock-based compensation.',
    },
  ],
};

describe('EarningsNarrativeExtractionSchema', () => {
  it('accepts guidance, claims, and supplemental facts', () => {
    const parsed = EarningsNarrativeExtractionSchema.parse(validNarrative);
    expect(parsed.guidance).toHaveLength(1);
    expect(parsed.managementClaims).toHaveLength(1);
    expect(parsed.supplementalNonGaapFacts[0].metricLabel).toBe('Non-GAAP EPS');
  });

  it('defaults empty arrays', () => {
    const parsed = EarningsNarrativeExtractionSchema.parse({});
    expect(parsed.guidance).toEqual([]);
    expect(parsed.managementClaims).toEqual([]);
    expect(parsed.supplementalNonGaapFacts).toEqual([]);
  });

  it('strips canonical core actual facts structurally', () => {
    const parsed = EarningsNarrativeExtractionSchema.parse({
      ...validNarrative,
      facts: [{ metricCode: 'revenue', value: '999' }],
    });
    expect('facts' in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('999');
  });

  it('requires a source quote for guidance', () => {
    expect(() =>
      EarningsNarrativeExtractionSchema.parse({
        guidance: [
          {
            metricCode: 'revenue',
            value: { kind: 'range', min: '1', max: '2' },
            unit: 'currency',
            currency: 'USD',
            scale: 1,
            targetPeriodEndOn: '2026-12-31',
            targetPeriodType: 'FY',
            accountingBasis: 'US-GAAP',
            consolidationScope: 'consolidated',
          },
        ],
      }),
    ).toThrow();
  });
});

describe('SupplementalFactCandidateSchema', () => {
  it('requires currency for per_share supplemental facts', () => {
    expect(() =>
      SupplementalFactCandidateSchema.parse({
        metricLabel: 'Non-GAAP EPS',
        value: { kind: 'scalar', value: '2.5' },
        unit: 'per_share',
        targetPeriodEndOn: '2025-12-31',
        sourceQuote: 'Non-GAAP diluted EPS was $2.50.',
      }),
    ).toThrow();
  });

  it('rejects supplemental facts without a source quote', () => {
    expect(() =>
      SupplementalFactCandidateSchema.parse({
        metricLabel: 'Adjusted EBITDA',
        value: { kind: 'scalar', value: '100' },
        unit: 'currency',
        currency: 'USD',
        targetPeriodEndOn: '2025-12-31',
      }),
    ).toThrow();
  });
});
