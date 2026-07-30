import { describe, expect, it } from 'vitest';
import type { SourcePlugin } from './plugin';
import { SourceRegistry } from './registry';

describe('SourceRegistry', () => {
  it('registers a new source from its manifest and runtime configuration', () => {
    const plugin: SourcePlugin<{ enabled?: boolean; apiBaseUrl: string }> = {
      manifest: {
        id: 'example-hk',
        name: 'Example HK data',
        sourceType: 'licensed-vendor',
        requiresAuth: true,
        allowRedistribution: false,
        rateLimit: { concurrent: 2 },
        capabilities: [{
          capability: 'quote',
          markets: ['HK'],
          qualityTier: 'B',
          authority: 'licensed',
          redistribution: 'credential-cache-only',
          ttlMs: 15_000,
        }],
      },
      create(config) {
        expect(config.apiBaseUrl).toBe('https://example.test');
        return {
          manifest: plugin.manifest,
          enabled: config.enabled ?? true,
          credentialScope: 'credential:example-hk-system',
          ports: {
            finance: {
              async getQuote() { throw new Error('not called'); },
              async getHistory() { throw new Error('not called'); },
            },
          },
        };
      },
    };
    const registry = new SourceRegistry();

    registry.registerPlugin(plugin, { apiBaseUrl: 'https://example.test' });

    expect(registry.find({ capability: 'quote', market: 'HK' }))
      .toHaveLength(1);
  });

  it('rejects a plugin that declares a capability without its canonical port', () => {
    const plugin: SourcePlugin = {
      manifest: {
        id: 'broken',
        name: 'Broken source',
        sourceType: 'public-api',
        requiresAuth: false,
        allowRedistribution: true,
        rateLimit: { concurrent: 1 },
        capabilities: [{
          capability: 'financials',
          markets: ['US'],
          qualityTier: 'C',
          authority: 'aggregated',
          redistribution: 'public-cache-allowed',
          ttlMs: 1_000,
        }],
      },
      create() {
        return { manifest: plugin.manifest, enabled: true, credentialScope: 'public', ports: {} };
      },
    };

    expect(() => new SourceRegistry().registerPlugin(plugin, {}))
      .toThrow('declares financials but does not implement its canonical port');
  });

  it('rejects a plugin instance whose source id differs from its manifest', () => {
    const plugin: SourcePlugin = {
      manifest: {
        id: 'declared',
        name: 'Declared source',
        sourceType: 'derived',
        requiresAuth: false,
        allowRedistribution: true,
        rateLimit: { concurrent: 1 },
        capabilities: [],
      },
      create() {
        return {
          manifest: { ...plugin.manifest, id: 'different' },
          enabled: true,
          credentialScope: 'public',
          ports: {},
        };
      },
    };

    expect(() => new SourceRegistry().registerPlugin(plugin, {}))
      .toThrow('created mismatched source different');
  });
});
