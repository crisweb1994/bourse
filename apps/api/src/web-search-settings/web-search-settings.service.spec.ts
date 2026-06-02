import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSearchSettingsService } from './web-search-settings.service';

/**
 * Stateless unit tests — exercise the validation + masking logic without
 * touching Prisma. Integration coverage (real upsert / executor build) is
 * left to the api e2e suite once the WebSearchSetting migration lands.
 */
describe('WebSearchSettingsService · validation', () => {
  // Stub prisma so `upsert` can call `findUnique` for the existing-row
  // preload step. Returning null mimics "no prior config for this user".
  const stubPrisma = {
    webSearchSetting: {
      findUnique: async () => null,
    },
  };
  const svc = new WebSearchSettingsService(stubPrisma as any);

  it('rejects TAVILY without apiKey (no existing row)', async () => {
    await assert.rejects(
      () =>
        svc.upsert('u1', {
          providerType: 'TAVILY',
        } as any),
      /Tavily requires apiKey/,
    );
  });

  it('rejects SEARXNG without baseUrl (no existing row)', async () => {
    await assert.rejects(
      () =>
        svc.upsert('u1', {
          providerType: 'SEARXNG',
        } as any),
      /SearXNG requires baseUrl/,
    );
  });

  it('test() folds TAVILY-without-apiKey into {ok:false, error}', async () => {
    // The /test endpoint semantics: return a test result object, not throw.
    // Returning 500 for "user forgot to fill apiKey" is hostile UX, so the
    // validation error becomes part of the response payload (parallel to
    // how executor.execute() failures are handled).
    const result = await svc.test({ providerType: 'TAVILY' } as any);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Tavily requires apiKey/);
  });

  it('test() folds SEARXNG-without-baseUrl into {ok:false, error}', async () => {
    const result = await svc.test({ providerType: 'SEARXNG' } as any);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /SearXNG requires baseUrl/);
  });
});

describe('WebSearchSettingsService · upsert preserves existing fields', () => {
  it('keeps existing apiKey when DTO omits it and providerType matches', async () => {
    let captured: { create?: any; update?: any } = {};
    const stub = {
      webSearchSetting: {
        findUnique: async () => ({
          userId: 'u1',
          providerType: 'TAVILY',
          apiKey: 'tvly-OLD-KEY-1234',
          baseUrl: null,
          primaryMode: 'NATIVE_FIRST',
          timeoutMs: null,
          budgetUsdPerRun: null,
          cacheTtlMs: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        upsert: async (args: any) => {
          captured = { create: args.create, update: args.update };
          return {
            providerType: 'TAVILY',
            apiKey: args.update.apiKey,
            baseUrl: null,
            primaryMode: args.update.primaryMode,
            timeoutMs: null,
            budgetUsdPerRun: null,
            cacheTtlMs: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
    };
    const svc = new WebSearchSettingsService(stub as any);
    await svc.upsert('u1', {
      providerType: 'TAVILY',
      primaryMode: 'CUSTOM_ONLY',
    } as any);
    assert.equal(captured.update.apiKey, 'tvly-OLD-KEY-1234');
    assert.equal(captured.update.primaryMode, 'CUSTOM_ONLY');
  });

  it('clears existing apiKey when switching providerType', async () => {
    let captured: any = {};
    const stub = {
      webSearchSetting: {
        findUnique: async () => ({
          userId: 'u1',
          providerType: 'TAVILY',
          apiKey: 'tvly-OLD-1234',
          baseUrl: null,
          primaryMode: 'NATIVE_FIRST',
          timeoutMs: null,
          budgetUsdPerRun: null,
          cacheTtlMs: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        upsert: async (args: any) => {
          captured = args.update;
          return {
            providerType: 'SEARXNG',
            apiKey: null,
            baseUrl: args.update.baseUrl,
            primaryMode: 'NATIVE_FIRST',
            timeoutMs: null,
            budgetUsdPerRun: null,
            cacheTtlMs: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
    };
    const svc = new WebSearchSettingsService(stub as any);
    await svc.upsert('u1', {
      providerType: 'SEARXNG',
      baseUrl: 'https://searxng.example.com',
    } as any);
    assert.equal(captured.apiKey, null);
    assert.equal(captured.baseUrl, 'https://searxng.example.com');
  });
});

describe('WebSearchSettingsService · apiKey masking', () => {
  // Indirectly via toDto's call to maskApiKey. We use the module-private
  // helper through a constructed row.
  const svc = new WebSearchSettingsService(null as any) as any;

  it('preserves tvly- prefix and exposes last 4 chars', () => {
    const masked = svc.toDto({
      providerType: 'TAVILY',
      apiKey: 'tvly-abcdefghij1234JK9F',
      baseUrl: null,
      primaryMode: 'NATIVE_FIRST',
      timeoutMs: null,
      budgetUsdPerRun: null,
      cacheTtlMs: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    assert.equal(masked.apiKeyMasked, 'tvly-••••••••JK9F');
  });

  it('returns null when apiKey is null', () => {
    const masked = svc.toDto({
      providerType: 'SEARXNG',
      apiKey: null,
      baseUrl: 'https://searxng.example.com',
      primaryMode: 'NATIVE_FIRST',
      timeoutMs: null,
      budgetUsdPerRun: null,
      cacheTtlMs: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    assert.equal(masked.apiKeyMasked, null);
  });

  it('masks short keys as 8 dots', () => {
    const masked = svc.toDto({
      providerType: 'SEARXNG',
      apiKey: 'short',
      baseUrl: 'x',
      primaryMode: 'NATIVE_FIRST',
      timeoutMs: null,
      budgetUsdPerRun: null,
      cacheTtlMs: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    assert.equal(masked.apiKeyMasked, '••••••••');
  });
});
