import { describe, expect, it } from 'vitest';
import { createResearchMarketDataClient } from '../client';
import type { SourcePlugin } from './plugin';
import { SourceRegistry } from './registry';

describe('SourcePlugin integration', () => {
  it('routes a capability-only client request through a newly registered source', async () => {
    let contextKeys: string[] = [];
    const plugin: SourcePlugin<{ enabled?: boolean; apiKey: string }> = {
      manifest: {
        id: 'example-hk',
        name: 'Example HK source',
        sourceType: 'licensed-vendor',
        requiresAuth: true,
        allowRedistribution: false,
        rateLimit: { concurrent: 2 },
        capabilities: [{
          capability: 'quote',
          markets: ['HK'],
          securityTypes: ['stock'],
          qualityTier: 'B',
          authority: 'licensed',
          redistribution: 'credential-cache-only',
          ttlMs: 10_000,
          delay: 'realtime',
        }],
      },
      create(config) {
        expect(config.apiKey).toBe('secret');
        return {
          manifest: plugin.manifest,
          enabled: config.enabled ?? true,
          credentialScope: 'credential:example-hk-system',
          ports: {
            finance: {
              async getQuote({ instrumentId }, context) {
                contextKeys = Object.keys(context ?? {});
                return {
                  status: 'ok',
                  data: {
                    instrument: { instrumentId, market: 'HK', symbol: '0700' },
                    price: 550,
                    currency: 'HKD',
                    timestamp: '2026-07-29T08:00:00.000Z',
                  },
                  sourceId: 'example-hk',
                  citations: [],
                  freshness: [],
                  warnings: [],
                };
              },
              async getHistory() {
                return {
                  status: 'empty',
                  data: null,
                  sourceId: 'example-hk',
                  citations: [],
                  freshness: [],
                  warnings: [],
                };
              },
            },
          },
        };
      },
    };
    const registry = new SourceRegistry();
    registry.registerPlugin(plugin, { apiKey: 'secret' });
    const client = createResearchMarketDataClient(registry);

    const result = await client.getQuote('HK:0700');

    expect(result.data?.price).toBe(550);
    if (result.status !== 'ok' && result.status !== 'partial') throw new Error('expected routed quote');
    expect(result.trace.selectedSource).toBe('example-hk');
    expect(contextKeys).not.toContain('apiKey');
  });
});
