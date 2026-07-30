import { describe, expect, it, vi } from 'vitest';
import { createMarketData } from '../../client';
import type { FetchLike } from '../types';
import { createMassiveSourcePlugin, parseMassiveCapabilities, parseMassiveDelay, parseMassiveIntervals } from './index';

describe('Massive REST source', () => {
  it('projects plan declarations into the effective manifest', () => {
    const instance = createMassiveSourcePlugin().create({
      apiKey: 'licensed-secret',
      enabledCapabilities: ['quote', 'history'],
      delay: 'delayed',
      historyIntervals: ['1d', '5m'],
      requestsPerMinute: 300,
    }, {});
    expect(instance.manifest.capabilities).toEqual([
      expect.objectContaining({ capability: 'quote', delay: 'delayed' }),
      expect.objectContaining({ capability: 'history', intervals: ['1d', '5m'] }),
    ]);
    expect(instance.manifest.rateLimit.maxRequests).toBe(300);
    expect(instance.credentialScope).not.toContain('licensed-secret');
  });

  it('routes and normalizes a US last trade without leaking the API key in citations', async () => {
    let requestedUrl = '';
    const fetchLike: FetchLike = vi.fn(async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, json: async () => ({ results: { T: 'AAPL', p: 215.25, s: 10, t: 1_775_000_000_000 } }) };
    });
    const client = createMarketData({ massive: { apiKey: 'secret-key', enabledCapabilities: ['quote'], delay: 'realtime', historyIntervals: [], fetchLike } });
    const result = await client.getQuote('US:AAPL', {}, { acceptedDelays: ['realtime'] });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toMatchObject({ price: 215.25, currency: 'USD' });
    expect(result.trace.selectedSource).toBe('massive');
    expect(requestedUrl).toContain('apiKey=secret-key');
    expect(result.citations[0]?.url).not.toContain('secret-key');
  });

  it('fails with INVALID_PAYLOAD when the upstream schema drifts', async () => {
    const fetchLike: FetchLike = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }));
    const instance = createMassiveSourcePlugin().create({ apiKey: 'secret-key', enabledCapabilities: ['profile'], delay: 'eod', historyIntervals: [], fetchLike }, {});
    const result = await instance.ports.finance!.getProfile!({ instrumentId: 'US:AAPL' });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' ? result.error?.code : undefined).toBe('INVALID_PAYLOAD');
  });

  it('parses only supported plan declarations', () => {
    expect(parseMassiveCapabilities('quote,options,profile')).toEqual(['quote', 'profile']);
    expect(parseMassiveIntervals('1d,second,5m')).toEqual(['1d', '5m']);
    expect(parseMassiveDelay('realtime')).toBe('realtime');
    expect(parseMassiveDelay('unknown')).toBeUndefined();
  });
});
