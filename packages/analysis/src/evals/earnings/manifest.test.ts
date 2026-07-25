import { describe, expect, it } from 'vitest';
import {
  assertEarningsEvalComposition,
  EarningsEvalManifestSchema,
  selectEarningsEvalSamples,
  type EarningsEvalManifest,
} from './manifest';

function validManifest(): EarningsEvalManifest {
  const cn = Array.from({ length: 10 }, (_, index) => ({
    id: `CN_${index}`,
    market: 'CN' as const,
    symbol: String(600000 + index),
    formType: 'quarterly',
    split: index < 2 ? 'development' as const : 'blind' as const,
    vendorFile: `cn-${index}.json`,
    sizeTier: (index === 0 ? 'large' : index === 1 ? 'mid' : 'small') as 'large' | 'mid' | 'small',
    correction: index === 9,
  }));
  const us = Array.from({ length: 5 }, (_, index) => ({
    id: `US_${index}`,
    market: 'US' as const,
    symbol: `US${index}`,
    formType: '8-K',
    split: index === 0 ? 'development' as const : 'blind' as const,
    vendorFile: `us-${index}.json`,
    correction: false,
  }));
  return EarningsEvalManifestSchema.parse({
    schemaVersion: 'earnings-eval-manifest-v1',
    samples: [...cn, ...us],
  });
}

describe('assertEarningsEvalComposition', () => {
  it('accepts the required Phase 0 sample mix', () => {
    expect(() => assertEarningsEvalComposition(validManifest())).not.toThrow();
  });

  it('rejects a manifest that can evade the correction requirement', () => {
    const manifest = validManifest();
    manifest.samples.forEach((sample) => { sample.correction = false; });
    expect(() => assertEarningsEvalComposition(manifest)).toThrow(/include a correction/);
  });

  it('selects one split without exposing blind samples to development runs', () => {
    const selected = selectEarningsEvalSamples(validManifest(), 'development');

    expect(selected).toHaveLength(3);
    expect(selected.every((sample) => sample.split === 'development')).toBe(true);
  });

  it('rejects --only selections outside the requested split', () => {
    expect(() => selectEarningsEvalSamples(validManifest(), 'development', ['CN_2']))
      .toThrow(/do not belong to the development split: CN_2/);
  });

  it('rejects unknown --only sample ids', () => {
    expect(() => selectEarningsEvalSamples(validManifest(), 'blind', ['MISSING']))
      .toThrow(/unknown earnings eval sample.*MISSING/);
  });
});
