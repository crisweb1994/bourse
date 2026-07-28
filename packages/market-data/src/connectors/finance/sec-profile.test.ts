import { describe, expect, it } from 'vitest';
import { createSecEdgarProfileConnector } from './sec-profile';
import type { FetchLike } from '../types';

const USER_AGENT = 'Bourse tests test@example.com';

function response(body: unknown, ok = true, status = 200): ReturnType<FetchLike> {
  return Promise.resolve({ ok, status, json: async () => body } as Response);
}

function connector(fetchLike: FetchLike) {
  return createSecEdgarProfileConnector({
    userAgent: USER_AGENT,
    fetchLike,
    cikLookup: {
      resolve: async () => ({ cik: '0000320193', name: 'Apple Inc.' }),
    },
  });
}

describe('SEC EDGAR profile connector', () => {
  it('projects issuer identity and SIC classification with an official citation', async () => {
    let requestUrl = '';
    const out = await connector(async (url) => {
      requestUrl = String(url);
      return response({
        name: 'Apple Inc.',
        sic: '3571',
        sicDescription: 'ELECTRONIC COMPUTERS',
        entityType: 'operating',
      });
    }).getProfile({ instrumentId: 'US:AAPL' });

    expect(requestUrl).toBe('https://data.sec.gov/submissions/CIK0000320193.json');
    expect(out.data.industry).toBe('ELECTRONIC COMPUTERS');
    expect(out.data.description).toContain('Apple Inc.');
    expect(out.citations[0]).toMatchObject({
      provider: 'sec-edgar-profile',
      sourceType: 'FILING',
      qualityTier: 'A',
    });
  });

  it('rejects non-US instruments without fetching', async () => {
    let called = false;
    const out = await connector(async () => {
      called = true;
      return response({});
    }).getProfile({ instrumentId: 'HK:0700' });

    expect(called).toBe(false);
    expect(out.warnings[0]?.code).toBe('UNSUPPORTED_MARKET');
  });

  it('returns a structured unavailable result on upstream failure', async () => {
    const out = await connector(async () => response({}, false, 503))
      .getProfile({ instrumentId: 'US:AAPL' });

    expect(out.data.description).toBeUndefined();
    expect(out.warnings[0]).toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      provider: 'sec-edgar-profile',
    });
  });
});
