import { describe, expect, it } from 'vitest';
import { loadWebSearchConfigFromEnv } from '../../../tools/web-search/config';
import { buildAdapterFromEnv } from '../../../tools/web-search/registry';

describe('loadWebSearchConfigFromEnv', () => {
  it('returns null when WEB_SEARCH_PROVIDER unset', () => {
    expect(loadWebSearchConfigFromEnv({})).toBeNull();
  });

  it('returns null on unknown provider id', () => {
    expect(
      loadWebSearchConfigFromEnv({
        WEB_SEARCH_PROVIDER: 'serper',
        SERPER_API_KEY: 'x',
      }),
    ).toBeNull();
  });

  it('returns null when searxng configured without base URL', () => {
    expect(
      loadWebSearchConfigFromEnv({ WEB_SEARCH_PROVIDER: 'searxng' }),
    ).toBeNull();
  });

  it('loads searxng config from env (with defaults)', () => {
    const cfg = loadWebSearchConfigFromEnv({
      WEB_SEARCH_PROVIDER: 'searxng',
      SEARXNG_BASE_URL: 'https://s.example.com',
    });
    expect(cfg).toMatchObject({
      providerId: 'searxng',
      baseUrl: 'https://s.example.com',
      timeoutMs: 12000,
    });
    expect(cfg?.maxSearchesPerRun).toBeGreaterThan(0);
  });

  it('ignores demoted tuning knobs — provider/keys from env, timing from constants (KISS env review)', () => {
    const cfg = loadWebSearchConfigFromEnv({
      WEB_SEARCH_PROVIDER: 'searxng',
      SEARXNG_BASE_URL: 'https://s.example.com',
      SEARXNG_API_KEY: 'k',
      WEB_SEARCH_TIMEOUT_MS: '5000',
      WEB_SEARCH_MAX_SEARCHES_PER_RUN: '25',
      WEB_SEARCH_CACHE_TTL_MS: '60000',
    });
    expect(cfg).toMatchObject({
      apiKey: 'k',
      timeoutMs: 12_000,
      maxSearchesPerRun: 50,
      cacheTtlMs: 5 * 60 * 1000,
    });
  });

  it('buildAdapterFromEnv returns null when no config', () => {
    expect(buildAdapterFromEnv({})).toBeNull();
  });

  it('buildAdapterFromEnv builds a searxng adapter', () => {
    const built = buildAdapterFromEnv({
      WEB_SEARCH_PROVIDER: 'searxng',
      SEARXNG_BASE_URL: 'https://s.example.com',
    });
    expect(built?.adapter.name).toBe('searxng');
  });
});
