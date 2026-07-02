import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DigestSubscriptionService } from './digest.service';

// Stateless unit tests — validation / keep-existing / masking，不碰 Prisma。
// 真实 upsert 集成留 e2e。

const FEISHU = (secret: string) => ({
  type: 'FEISHU' as const,
  url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x',
  secret,
});

describe('DigestSubscriptionService · validation', () => {
  const stubPrisma = { digestSubscription: { findUnique: async () => null } };
  const svc = new DigestSubscriptionService(stubPrisma as any);

  it('rejects invalid market', async () => {
    await assert.rejects(
      () =>
        svc.upsert('u1', {
          markets: ['XX'],
          sessions: ['PRE'],
          channels: [FEISHU('s1')],
        } as any),
      /invalid market/,
    );
  });

  it('rejects invalid session', async () => {
    await assert.rejects(
      () =>
        svc.upsert('u1', {
          markets: ['US'],
          sessions: ['XX'],
          channels: [FEISHU('s1')],
        } as any),
      /invalid session/,
    );
  });

  it('rejects FEISHU channel missing url (zod)', async () => {
    await assert.rejects(
      () =>
        svc.upsert('u1', {
          markets: ['US'],
          sessions: ['PRE'],
          channels: [{ type: 'FEISHU' }],
        } as any),
      /invalid channels/,
    );
  });

  it('rejects TELEGRAM channel missing botToken (zod)', async () => {
    await assert.rejects(
      () =>
        svc.upsert('u1', {
          markets: ['US'],
          sessions: ['PRE'],
          channels: [{ type: 'TELEGRAM', chatId: '1' }],
        } as any),
      /invalid channels/,
    );
  });
});

describe('DigestSubscriptionService · keep-existing secrets', () => {
  const baseRow = {
    userId: 'u1',
    markets: ['US'],
    sessions: ['PRE'],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('keeps existing FEISHU secret when incoming is masked', async () => {
    let captured: any = {};
    const stub = {
      digestSubscription: {
        findUnique: async () => ({
          ...baseRow,
          channels: [FEISHU('REAL-SECRET-5678')],
        }),
        upsert: async (args: any) => {
          captured = args.update;
          return { ...baseRow, ...args.create };
        },
      },
    };
    const svc = new DigestSubscriptionService(stub as any);
    await svc.upsert('u1', {
      markets: ['US'],
      sessions: ['PRE'],
      channels: [FEISHU('••••5678')], // mask 形态 → 应保留旧值
    } as any);
    assert.equal(captured.channels[0].secret, 'REAL-SECRET-5678');
  });

  it('uses new secret when incoming is a fresh value', async () => {
    let captured: any = {};
    const stub = {
      digestSubscription: {
        findUnique: async () => ({ ...baseRow, channels: [FEISHU('OLD')] }),
        upsert: async (args: any) => {
          captured = args.update;
          return { ...baseRow, ...args.create };
        },
      },
    };
    const svc = new DigestSubscriptionService(stub as any);
    await svc.upsert('u1', {
      markets: ['US'],
      sessions: ['PRE'],
      channels: [FEISHU('NEW-SECRET-9999')],
    } as any);
    assert.equal(captured.channels[0].secret, 'NEW-SECRET-9999');
  });
});

describe('DigestSubscriptionService · masking on get', () => {
  it('masks secret/botToken in get response; leaves WECOM untouched', async () => {
    const stub = {
      digestSubscription: {
        findUnique: async () => ({
          userId: 'u1',
          markets: ['US'],
          sessions: ['PRE'],
          enabled: true,
          channels: [
            FEISHU('abcdefgh5678'),
            { type: 'TELEGRAM', botToken: '1234567890:ABC', chatId: '99' },
            { type: 'WECOM', url: 'https://y' },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    };
    const svc = new DigestSubscriptionService(stub as any);
    const out = await svc.get('u1');
    // channels is ChannelConfig[] (discriminated union) — index access narrows
    // to the union, so cast per element to read variant-specific fields.
    const ch = out!.channels as any[];
    assert.equal(ch[0].secret, '••••5678');
    assert.equal(ch[1].botToken, '••••:ABC');
    assert.equal(ch[2].url, 'https://y'); // WECOM 无敏感字段，不变
  });

  it('returns null when no subscription', async () => {
    const stub = { digestSubscription: { findUnique: async () => null } };
    const svc = new DigestSubscriptionService(stub as any);
    assert.equal(await svc.get('u1'), null);
  });
});
