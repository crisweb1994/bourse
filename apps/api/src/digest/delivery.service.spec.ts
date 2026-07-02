import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DigestDeliveryService } from './delivery.service';
import { WebhookAdapter } from './channel/webhook.adapter';
import { FeishuAdapter } from './channel/feishu.adapter';
import { TelegramAdapter } from './channel/telegram.adapter';
import type { BriefPayload, ChannelConfig } from '@bourse/analysis';

// ============================================================================
// 单测：DigestDeliveryService。fetch 全局 stub，验证重试 / DeliveryRecord / 脱敏 /
// HMAC。不碰真实 IM 端点。
// ============================================================================

function aPayload(): BriefPayload {
  return {
    market: 'US',
    session: 'POST',
    generatedAt: '2026-07-02T13:00:00.000Z',
    dataAsOf: '2026-07-02T13:00:00.000Z',
    marketOverview: {
      indices: [
        { symbol: '^GSPC', name: 'S&P 500', changePct: 0.6, vsSma50: 1.2, rsi14: 55 },
      ],
      interpretation: '大盘偏强',
    },
    watchlist: {
      items: [
        {
          symbol: 'AAPL',
          changePct: 3.5,
          driftSinceLastAnalysis: -3.7,
          rsi14: 50,
          vsSma50: 0.6,
          vsSma200: 9.0,
          events: [],
          deepDive: 'AAPL 异动深入文本',
        },
      ],
      sectorAttribution: [{ sector: 'Technology', changePct: 2.4 }],
      interpretation: '自选偏强',
      reanalyzeHints: [{ symbol: 'AAPL', reason: '距上次分析超过 30 天且出现异动，建议复研' }],
    },
  };
}

const WEBHOOK: ChannelConfig = {
  type: 'WEBHOOK',
  url: 'https://hook.example.com/inbox',
  secret: 'test-secret',
};
const FEISHU: ChannelConfig = {
  type: 'FEISHU',
  url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x',
};

interface FetchLog {
  url: string;
  headers: Record<string, string>;
  body: string;
}
function makeHarness(opts: {
  statusByHost?: Record<string, number | number[]>;
  errorByHost?: Record<string, Error>;
}) {
  const logs: FetchLog[] = [];
  let callsByHost: Record<string, number> = {};
  const statusFor = (host: string): number => {
    const seq = callsByHost[host] ?? 0;
    callsByHost[host] = seq + 1;
    const def = opts.statusByHost?.[host];
    if (Array.isArray(def)) return def[Math.min(seq, def.length - 1)] ?? 500;
    return def ?? 200;
  };

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const host = new URL(u).host;
    logs.push({
      url: u,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: (init?.body as string) ?? '',
    });
    if (opts.errorByHost?.[host]) throw opts.errorByHost[host];
    const status = statusFor(host);
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as typeof fetch;

  return { logs, reset: () => { callsByHost = {}; logs.length = 0; } };
}

function makeService(prisma: any, subs: any): DigestDeliveryService {
  return new DigestDeliveryService(
    prisma,
    subs,
    new WebhookAdapter(),
    new FeishuAdapter(),
    new TelegramAdapter(),
  );
}

describe('DigestDeliveryService · 投递编排', () => {
  let harness: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    harness = makeHarness({});
  });

  it('无订阅 → no-op，不调 fetch 不写记录', async () => {
    const prisma = { deliveryRecord: { create: async () => { throw new Error('不应写记录'); } } };
    const subs = { getInternal: async () => null };
    const svc = makeService(prisma, subs);
    await svc.deliver('u1', 'US', 'POST', aPayload());
    assert.equal(harness.logs.length, 0);
  });

  it('enabled=false → no-op', async () => {
    const prisma = { deliveryRecord: { create: async () => { throw new Error('不应写记录'); } } };
    const subs = { getInternal: async () => ({ enabled: false, channels: [WEBHOOK] }) };
    const svc = makeService(prisma, subs);
    await svc.deliver('u1', 'US', 'POST', aPayload());
    assert.equal(harness.logs.length, 0);
  });

  it('两渠道都 SENT → 各写一条 SENT 记录', async () => {
    const records: any[] = [];
    const prisma = { deliveryRecord: { create: async (a: any) => { records.push(a.data); return a.data; } } };
    const subs = { getInternal: async () => ({ enabled: true, channels: [WEBHOOK, FEISHU] }) };
    const svc = makeService(prisma, subs);
    await svc.deliver('u1', 'US', 'POST', aPayload());
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.status).sort(), ['SENT', 'SENT']);
    // 脱敏：target 是域名，不含完整 url / secret（两渠道并发，顺序不保证 → 按 type 找）
    const webhookRec = records.find((r) => r.channelType === 'WEBHOOK');
    assert.equal(webhookRec.target, 'hook.example.com');
    assert.ok(!JSON.stringify(records).includes('test-secret'));
  });

  it('单渠道失败 → 重试 3 次后 FAILED，另一渠道不受影响', async () => {
    harness.reset();
    makeHarness({ statusByHost: { 'hook.example.com': [500, 500, 500] } });
    const records: any[] = [];
    const prisma = { deliveryRecord: { create: async (a: any) => { records.push(a.data); return a.data; } } };
    const subs = { getInternal: async () => ({ enabled: true, channels: [WEBHOOK, FEISHU] }) };
    const svc = makeService(prisma, subs);
    await svc.deliver('u1', 'US', 'POST', aPayload());
    const webhookRec = records.find((r) => r.channelType === 'WEBHOOK');
    const feishuRec = records.find((r) => r.channelType === 'FEISHU');
    assert.equal(webhookRec.status, 'FAILED');
    assert.equal(webhookRec.httpStatus, 500);
    assert.equal(webhookRec.error, 'HTTP 500');
    assert.equal(feishuRec.status, 'SENT'); // 另一渠道正常
  });

  it('第二第三次成功 → 最终 SENT（中途重试）', async () => {
    makeHarness({ statusByHost: { 'hook.example.com': [500, 200] } });
    const records: any[] = [];
    const prisma = { deliveryRecord: { create: async (a: any) => { records.push(a.data); return a.data; } } };
    const subs = { getInternal: async () => ({ enabled: true, channels: [WEBHOOK] }) };
    const svc = makeService(prisma, subs);
    await svc.deliver('u1', 'US', 'POST', aPayload());
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'SENT');
    assert.equal(records[0].httpStatus, 200);
  });
});

describe('DigestDeliveryService · Webhook HMAC', () => {
  it('HMAC-SHA256 签名头正确（接收方可据 hex 验签）', async () => {
    const harness = makeHarness({});
    const prisma = { deliveryRecord: { create: async () => ({}) } };
    const subs = { getInternal: async () => ({ enabled: true, channels: [WEBHOOK] }) };
    const svc = makeService(prisma, subs);
    const payload = aPayload();
    await svc.deliver('u1', 'US', 'POST', payload);

    const log = harness.logs[0];
    const sigHeader = log.headers['X-Bourse-Signature'];
    assert.match(sigHeader, /^sha256=[0-9a-f]+$/);
    // 独立重算 HMAC 验签
    const expected = createHmac('sha256', 'test-secret').update(log.body).digest('hex');
    assert.equal(sigHeader, `sha256=${expected}`);
    // body 是完整 BriefPayload JSON（provenance 透传，不变式 #5）
    const parsed = JSON.parse(log.body);
    assert.equal(parsed.market, 'US');
    assert.equal(parsed.dataAsOf, payload.dataAsOf);
  });
});

describe('DigestDeliveryService · 脱敏', () => {
  it('Telegram target 用 chatId 末四位，不含 botToken', async () => {
    const tg: ChannelConfig = { type: 'TELEGRAM', botToken: '1234567890:ABCsecret', chatId: '987654' };
    const records: any[] = [];
    const prisma = { deliveryRecord: { create: async (a: any) => { records.push(a.data); return a.data; } } };
    const subs = { getInternal: async () => ({ enabled: true, channels: [tg] }) };
    const svc = makeService(prisma, subs);
    await svc.deliver('u1', 'US', 'POST', aPayload());
    assert.equal(records[0].target, 'tg:7654');
    assert.ok(!JSON.stringify(records[0]).includes('ABCsecret'));
  });
});
