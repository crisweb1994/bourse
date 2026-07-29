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
          ports: {},
        };
      },
    };
    const registry = new SourceRegistry();

    registry.registerPlugin(plugin, { apiBaseUrl: 'https://example.test' });

    expect(registry.find({ capability: 'quote', market: 'HK' }))
      .toHaveLength(1);
  });
});
