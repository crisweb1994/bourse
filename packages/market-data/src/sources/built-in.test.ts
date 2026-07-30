import { describe, expect, it } from 'vitest';
import type { ProviderFinancePort } from '../ports/finance';
import { createBuiltInSources } from './built-in';
import { SourceRegistry } from './registry';

const notCalled = async (): Promise<never> => {
  throw new Error('test connector should not be called');
};

const finance: ProviderFinancePort = {
  getQuote: notCalled,
  getHistory: notCalled,
  getProfile: notCalled,
};

describe('built-in source manifests', () => {
  it('declares history intervals so the registry filters before connector execution', () => {
    const registry = new SourceRegistry(createBuiltInSources({
      twelveData: finance,
      yahoo: finance,
    }));

    expect(registry.find({ capability: 'history', market: 'US', interval: '1h' })
      .map((candidate) => candidate.instance.manifest.id)).toEqual(['twelve-data']);
    expect(registry.find({ capability: 'history', market: 'US', interval: '1d' })
      .map((candidate) => candidate.instance.manifest.id)).toEqual(['yahoo', 'twelve-data']);
  });
});
