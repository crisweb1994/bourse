import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DigestTriggerService } from './trigger.service';

// ============================================================================
// 单测：DigestTriggerService。窗口判断用固定 Date 强制命中；generator/delivery
// stub；幂等靠 DeliveryRecord.count 模拟。
// ============================================================================

function makeService(opts: {
  generator?: { generate: (uid: string, m: string, s: string) => Promise<any> };
  delivery?: { deliver: (uid: string, m: string, s: string, p: any) => Promise<void> };
  subscribers?: Record<string, string[]>; // market → userIds
  sentRecords?: Set<string>; // `${userId}|${market}|${session}|${localYmd}`
}) {
  const generator = opts.generator ?? {
    generate: async () => ({ generated: true }),
  };
  const delivery = opts.delivery ?? { deliver: async () => undefined };
  const subscribers = opts.subscribers ?? {};
  const sentRecords = opts.sentRecords ?? new Set<string>();

  const prisma: any = {
    digestSubscription: {
      findMany: async ({ where }: any) => {
        const m = (where.markets?.has as string) ?? 'US';
        return (subscribers[m] ?? []).map((userId) => ({ userId }));
      },
    },
    deliveryRecord: {
      count: async ({ where }: any) => {
        const key = `${where.userId}|${where.market}|${where.session}`;
        // 简化：只要 set 里有该键就算已发（单测不验 ymd 边界，只验幂等逻辑）
        const localYmd = where.attemptedAt?.gte
          ? new Date(where.attemptedAt.gte).toISOString().slice(0, 10)
          : '';
        return sentRecords.has(`${key}|${localYmd}`) ? 1 : 0;
      },
    },
  };
  return {
    svc: new DigestTriggerService(prisma, generator as any, delivery as any),
    sentRecords,
  };
}

describe('DigestTriggerService · 窗口未命中', () => {
  it('不在窗口 → no-op，不查订阅不生成不投递', async () => {
    let genCalled = false;
    let deliverCalled = false;
    const { svc } = makeService({
      generator: { generate: async () => { genCalled = true; return {}; } },
      delivery: { deliver: async () => { deliverCalled = true; } },
      subscribers: { US: ['u1'] },
    });
    // 2026-07-06 12:00 UTC ≈ US 08:00 ET（PRE 窗口 08:30 前）→ 全市场不命中
    const results = await svc.runHeartbeat(new Date(Date.UTC(2026, 6, 6, 12, 0)));
    assert.equal(results.length, 0);
    assert.equal(genCalled, false);
    assert.equal(deliverCalled, false);
  });
});

describe('DigestTriggerService · 命中窗口 + 幂等', () => {
  // US PRE 窗口 08:30-09:25 ET（夏令时 UTC-4）→ 12:30-13:25 UTC
  const usPreWindow = new Date(Date.UTC(2026, 6, 6, 12, 40)); // 08:40 ET

  it('命中 + 未发过 → 生成+投递，记录已发', async () => {
    const delivered: any[] = [];
    const { svc, sentRecords } = makeService({
      delivery: { deliver: async (uid, m, s, p) => { delivered.push({ uid, m, s, p }); } },
      subscribers: { US: ['u1', 'u2'] },
    });
    const results = await svc.runHeartbeat(usPreWindow);
    assert.equal(results.length, 1);
    assert.equal(results[0].market, 'US');
    assert.equal(results[0].session, 'PRE');
    assert.equal(results[0].delivered, 2);
    assert.equal(delivered.length, 2);
  });

  it('当日已 SENT → 跳过（幂等），不重复生成投递', async () => {
    let genCalls = 0;
    const { svc } = makeService({
      generator: { generate: async () => { genCalls += 1; return {}; } },
      // 模拟 u1 当日已发：runHeartbeat 会用 localYmd 构造 attemptedAt.gte
      // 这里通过 pre-populate set（key 含 localYmd=2026-07-06）
      sentRecords: new Set([`u1|US|PRE|2026-07-06`]),
      subscribers: { US: ['u1', 'u2'] },
    });
    const results = await svc.runHeartbeat(usPreWindow);
    assert.equal(results[0].delivered, 1); // 只有 u2
    assert.equal(results[0].skipped, 1); // u1 跳过
    assert.equal(genCalls, 1);
  });
});

describe('DigestTriggerService · 单用户失败不阻塞其它', () => {
  const usPreWindow = new Date(Date.UTC(2026, 6, 6, 12, 40));

  it('u1 生成抛错 → u2 仍正常投递', async () => {
    const delivered: string[] = [];
    const { svc } = makeService({
      generator: {
        generate: async (uid) => {
          if (uid === 'u1') throw new Error('boom');
          return {};
        },
      },
      delivery: { deliver: async (uid) => { delivered.push(uid); } },
      subscribers: { US: ['u1', 'u2'] },
    });
    const results = await svc.runHeartbeat(usPreWindow);
    assert.equal(results[0].delivered, 1);
    assert.deepEqual(delivered, ['u2']); // u1 失败，u2 成功
  });
});

describe('DigestTriggerService · 无订阅', () => {
  const usPreWindow = new Date(Date.UTC(2026, 6, 6, 12, 40));

  it('命中窗口但无订阅用户 → results 不含该市场（不报错）', async () => {
    const { svc } = makeService({ subscribers: {} });
    const results = await svc.runHeartbeat(usPreWindow);
    assert.equal(results.length, 0);
  });
});
