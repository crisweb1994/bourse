import { describe, expect, it } from 'vitest';
import {
  buildWebSearchExecutorFromSetting,
  WebSearchExecutor,
} from '../../../tools/web-search';

describe('buildWebSearchExecutorFromSetting', () => {
  it('NATIVE → returns null (caller skips adapter injection)', () => {
    expect(
      buildWebSearchExecutorFromSetting({ providerType: 'NATIVE' }),
    ).toBeNull();
  });

  it('SEARXNG with baseUrl → returns a WebSearchExecutor', () => {
    const exec = buildWebSearchExecutorFromSetting({
      providerType: 'searxng',
      baseUrl: 'https://my-searxng.local',
    });
    expect(exec).toBeInstanceOf(WebSearchExecutor);
    expect(exec!.providerId).toBe('searxng');
  });

  it('SEARXNG without baseUrl → throws (registry guard)', () => {
    expect(() =>
      buildWebSearchExecutorFromSetting({ providerType: 'searxng' }),
    ).toThrow(/baseUrl/);
  });

  it('honors budget / cache TTL overrides', () => {
    const exec = buildWebSearchExecutorFromSetting({
      providerType: 'searxng',
      baseUrl: 'https://my-searxng.local',
      budgetUsdPerRun: 1.25,
      cacheTtlMs: 60_000,
      timeoutMs: 4_000,
    });
    expect(exec).toBeInstanceOf(WebSearchExecutor);
    // Implementation details (budget / cache) are private — we mostly care
    // that construction succeeds with custom values.
  });
});
