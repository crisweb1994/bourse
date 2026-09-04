import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiSettingsService } from './ai-settings.service';

const NOW = new Date('2026-07-18T00:00:00.000Z');

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-1',
    userId: 'user-1',
    label: 'My Provider',
    providerType: 'OPENAI_COMPATIBLE',
    baseUrl: 'https://api.example.com/v1',
    apiKey: null,
    enabledModels: ['model-primary'],
    primaryModel: 'model-primary',
    utilityModel: null,
    supportsWebSearch: false,
    supportsTools: true,
    isDefault: true,
    enabled: true,
    provider: null,
    model: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// 凭证明文落库（产品决策：不做静态加密）；对外契约只暴露存在性与末四位 mask。
describe('AiSettingsService · credential storage', () => {
  it('stores the API key as provided when creating a provider', async () => {
    let createData: Record<string, unknown> | undefined;
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createData = data;
          return providerRow(data);
        },
      },
    };
    const service = new AiSettingsService(prisma as any);

    const detail = await service.create('user-1', {
      label: 'My Provider',
      providerType: 'OPENAI_COMPATIBLE',
      apiKey: 'sk-secret-1234',
      enabledModels: ['model-primary'],
      primaryModel: 'model-primary',
    });

    assert.equal(createData?.apiKey, 'sk-secret-1234');
    assert.equal(detail.hasApiKey, true);
    assert.equal(detail.apiKeyMasked, '****1234');
  });

  it('replaces the saved key when updating', async () => {
    let updateData: Record<string, unknown> | undefined;
    const existing = providerRow({ apiKey: 'sk-old' });
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => existing,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updateData = data;
          return providerRow({ ...existing, ...data });
        },
      },
    };
    const service = new AiSettingsService(prisma as any);

    const detail = await service.update('user-1', 'provider-1', {
      apiKey: 'sk-replacement-9876',
    });

    assert.equal(updateData?.apiKey, 'sk-replacement-9876');
    assert.equal(detail.apiKeyMasked, '****9876');
  });

  it('returns the stored key for runtime use', async () => {
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => providerRow({ apiKey: 'sk-secret-1234' }),
      },
    };
    const service = new AiSettingsService(prisma as any);

    const runtime = await service.getDefaultRuntime('user-1');

    assert.equal(runtime?.apiKey, 'sk-secret-1234');
  });

  it('clears the key only when explicitly requested', async () => {
    let updateData: Record<string, unknown> | undefined;
    const existing = providerRow({ apiKey: 'sk-old' });
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => existing,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updateData = data;
          return providerRow({ ...existing, ...data });
        },
      },
    };
    const service = new AiSettingsService(prisma as any);

    const detail = await service.update('user-1', 'provider-1', {
      clearApiKey: true,
    });

    assert.equal(updateData?.apiKey, null);
    assert.equal(detail.hasApiKey, false);
    assert.equal(detail.apiKeyMasked, null);
  });
});

describe('AiSettingsService · public credential contract', () => {
  it('returns credential-free summaries from list()', async () => {
    const prisma = {
      aiProviderSetting: {
        findMany: async () => [providerRow({ apiKey: 'never-read-by-list' })],
      },
    };
    const service = new AiSettingsService(prisma as any);

    const [summary] = await service.list('user-1');

    assert.equal(summary.id, 'provider-1');
    assert.equal('apiKey' in summary, false);
    assert.equal('apiKeyMasked' in summary, false);
    assert.equal('baseUrl' in summary, false);
  });

  it('returns only key presence and a suffix mask from get()', async () => {
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => providerRow({ apiKey: 'sk-secret-1234' }),
      },
    };
    const service = new AiSettingsService(prisma as any);

    const detail = await service.get('user-1', 'provider-1');

    assert.equal(detail.hasApiKey, true);
    assert.equal(detail.apiKeyMasked, '****1234');
    assert.equal('apiKey' in detail, false);
  });
});
