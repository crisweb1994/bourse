import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiSettingsService } from './ai-settings.service';

const NOW = new Date('2026-07-18T00:00:00.000Z');
const ENCRYPTION_SECRET = 'test-only-independent-credential-secret';

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-1',
    userId: 'user-1',
    label: 'My Provider',
    providerType: 'OPENAI_COMPATIBLE',
    baseUrl: 'https://api.example.com/v1',
    apiKey: null,
    apiKeyEncrypted: null,
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

function config(values: Record<string, string> = { AI_CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_SECRET }) {
  return {
    get: (name: string) => values[name],
  };
}

function encryptForTest(secret = ENCRYPTION_SECRET, apiKey = 'sk-secret-1234') {
  const service = new AiSettingsService({} as any, config({
    AI_CREDENTIALS_ENCRYPTION_KEY: secret,
  }) as any);
  return (service as any).encryptApiKey(apiKey) as string;
}

function encryptWithJwtFallback(jwtSecret: string, apiKey = 'sk-fallback-5678') {
  const service = new AiSettingsService({} as any, config({ JWT_SECRET: jwtSecret }) as any);
  return (service as any).encryptApiKey(apiKey) as string;
}

describe('AiSettingsService · credential storage', () => {
  it('stores only encrypted credentials when creating a provider', async () => {
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
    const service = new AiSettingsService(prisma as any, config() as any);

    const detail = await service.create('user-1', {
      label: 'My Provider',
      providerType: 'OPENAI_COMPATIBLE',
      apiKey: 'sk-secret-1234',
      enabledModels: ['model-primary'],
      primaryModel: 'model-primary',
    });

    assert.equal(createData?.apiKey, null);
    assert.match(String(createData?.apiKeyEncrypted), /^v1:/);
    assert.equal(String(createData?.apiKeyEncrypted).includes('sk-secret-1234'), false);
    assert.equal(detail.hasApiKey, true);
    assert.equal(detail.apiKeyMasked, '****1234');
  });

  it('stores only encrypted credentials when replacing a saved key', async () => {
    let updateData: Record<string, unknown> | undefined;
    const existing = providerRow({ apiKeyEncrypted: encryptForTest() });
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => existing,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updateData = data;
          return providerRow({ ...existing, ...data });
        },
      },
    };
    const service = new AiSettingsService(prisma as any, config() as any);

    const detail = await service.update('user-1', 'provider-1', {
      apiKey: 'sk-replacement-9876',
    });

    assert.equal(updateData?.apiKey, null);
    assert.match(String(updateData?.apiKeyEncrypted), /^v1:/);
    assert.equal(String(updateData?.apiKeyEncrypted).includes('sk-replacement-9876'), false);
    assert.equal(detail.apiKeyMasked, '****9876');
  });

  it('decrypts encrypted credentials for runtime use', async () => {
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => providerRow({ apiKeyEncrypted: encryptForTest() }),
      },
    };
    const service = new AiSettingsService(prisma as any, config() as any);

    const runtime = await service.getDefaultRuntime('user-1');

    assert.equal(runtime?.apiKey, 'sk-secret-1234');
  });

  it('lazily migrates a legacy plaintext credential after a successful encrypted write', async () => {
    let migrationData: Record<string, unknown> | undefined;
    let migrationWhere: Record<string, unknown> | undefined;
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => providerRow({ apiKey: 'sk-legacy-4321' }),
        updateMany: async ({ where, data }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          migrationWhere = where;
          migrationData = data;
          return { count: 1 };
        },
      },
    };
    const service = new AiSettingsService(prisma as any, config() as any);

    const detail = await service.get('user-1', 'provider-1');

    assert.equal(migrationWhere?.apiKey, 'sk-legacy-4321');
    assert.equal(migrationWhere?.apiKeyEncrypted, null);
    assert.equal(migrationData?.apiKey, null);
    assert.match(String(migrationData?.apiKeyEncrypted), /^v1:/);
    assert.equal(String(migrationData?.apiKeyEncrypted).includes('sk-legacy-4321'), false);
    assert.equal(detail.apiKeyMasked, '****4321');
  });

  it('re-encrypts JWT fallback ciphertext after a dedicated key is configured', async () => {
    const jwtSecret = 'legacy-jwt-secret';
    const oldCiphertext = encryptWithJwtFallback(jwtSecret);
    let rotationData: Record<string, unknown> | undefined;
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => providerRow({ apiKeyEncrypted: oldCiphertext }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          rotationData = data;
          return { count: 1 };
        },
      },
    };
    const service = new AiSettingsService(prisma as any, config({
      AI_CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_SECRET,
      JWT_SECRET: jwtSecret,
    }) as any);

    const detail = await service.get('user-1', 'provider-1');

    assert.equal(detail.apiKeyMasked, '****5678');
    assert.equal(rotationData?.apiKey, null);
    assert.match(String(rotationData?.apiKeyEncrypted), /^v1:/);
    assert.notEqual(rotationData?.apiKeyEncrypted, oldCiphertext);
  });

  it('clears both encrypted and legacy credential fields only when explicitly requested', async () => {
    let updateData: Record<string, unknown> | undefined;
    const existing = providerRow({ apiKeyEncrypted: encryptForTest() });
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => existing,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updateData = data;
          return providerRow({ ...existing, ...data });
        },
      },
    };
    const service = new AiSettingsService(prisma as any, config() as any);

    const detail = await service.update('user-1', 'provider-1', {
      clearApiKey: true,
    });

    assert.equal(updateData?.apiKey, null);
    assert.equal(updateData?.apiKeyEncrypted, null);
    assert.equal(detail.hasApiKey, false);
    assert.equal(detail.apiKeyMasked, null);
  });

  it('fails clearly when the configured key cannot decrypt a credential', async () => {
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => providerRow({
          apiKeyEncrypted: encryptForTest('original-secret'),
        }),
      },
    };
    const service = new AiSettingsService(prisma as any, config({
      AI_CREDENTIALS_ENCRYPTION_KEY: 'wrong-secret',
    }) as any);

    await assert.rejects(
      service.get('user-1', 'provider-1'),
      /Unable to decrypt stored AI credential/,
    );
  });

  it('fails clearly when no encryption secret is configured', async () => {
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => null,
      },
    };
    const service = new AiSettingsService(prisma as any, config({}) as any);

    await assert.rejects(
      service.create('user-1', {
        label: 'My Provider',
        providerType: 'OPENAI_COMPATIBLE',
        apiKey: 'sk-secret-1234',
      }),
      /AI credential encryption is not configured/,
    );
  });
});

describe('AiSettingsService · public credential contract', () => {
  it('returns credential-free summaries from list()', async () => {
    const prisma = {
      aiProviderSetting: {
        findMany: async () => [providerRow({ apiKeyEncrypted: 'never-read-by-list' })],
      },
    };
    const service = new AiSettingsService(prisma as any, config({}) as any);

    const [summary] = await service.list('user-1');

    assert.equal(summary.id, 'provider-1');
    assert.equal('apiKey' in summary, false);
    assert.equal('apiKeyEncrypted' in summary, false);
    assert.equal('apiKeyMasked' in summary, false);
    assert.equal('baseUrl' in summary, false);
  });

  it('returns only key presence and a suffix mask from get()', async () => {
    const prisma = {
      aiProviderSetting: {
        findFirst: async () => providerRow({ apiKeyEncrypted: encryptForTest() }),
      },
    };
    const service = new AiSettingsService(prisma as any, config() as any);

    const detail = await service.get('user-1', 'provider-1');

    assert.equal(detail.hasApiKey, true);
    assert.equal(detail.apiKeyMasked, '****1234');
    assert.equal('apiKey' in detail, false);
    assert.equal('apiKeyEncrypted' in detail, false);
  });
});
