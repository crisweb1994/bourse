#!/usr/bin/env tsx
/**
 * Daily Brief task7 端到端冒烟：trigger → 窗口判断 → 生成 → 投递 → 幂等。
 *
 * 流程：
 *  1. 起本地 HTTP echo server（接收 Webhook，记录 body + 签名头）
 *  2. 给 digest-smoke 用户 seed 一份订阅（指向本地 webhook，secret 已知）
 *  3. 用「US PRE 窗口时刻」跑 runHeartbeat → 真实生成 BriefPayload + 真实投递
 *  4. 验证：echo server 收到 1 条（含 HMAC 签名头）+ DeliveryRecord 写了 SENT
 *  5. 再跑一次同样时刻 → 验证幂等（echo server 不应再收第二条，skipped=1）
 *
 * 用法（apps/api 目录下）：
 *   pnpm -F @bourse/api exec tsx scripts/digest-trigger-smoke.ts
 *
 * 依赖：DB（bourse 库 + digest-smoke 用户已有 provider/自选股，task5 seed 过）。
 */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as dotenv from 'dotenv';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { DigestTriggerService } from '../src/digest/trigger.service';
import { DigestGeneratorService } from '../src/digest/brief.generator';
import { DigestDeliveryService } from '../src/digest/delivery.service';
import { DigestSubscriptionService } from '../src/digest/digest.service';
import { SnapshotV2Service } from '../src/analysis/snapshot-v2.service';
import { ProviderFactoryService } from '../src/analysis/provider-factory.service';
import { AiSettingsService } from '../src/ai-settings/ai-settings.service';
import { WebhookAdapter } from '../src/digest/channel/webhook.adapter';
import { FeishuAdapter } from '../src/digest/channel/feishu.adapter';
import { TelegramAdapter } from '../src/digest/channel/telegram.adapter';

dotenv.config({ path: '../../.env.local' });
dotenv.config({ path: '../../.env' });

const SEC_UA = process.env.RESEARCH_CORE_USER_AGENT?.trim() || 'smoke contact@example.com';
const TEST_GITHUB_ID = 'digest-smoke';
const WEBHOOK_SECRET = 'trigger-smoke-secret';

// US PRE 窗口 08:30-09:25 ET（夏令时 UTC-4）→ 12:30-13:25 UTC
// 2026-07-06 周一 12:40 UTC = 08:40 ET → 命中 PRE
const US_PRE_MOMENT = new Date(Date.UTC(2026, 6, 6, 12, 40));

function makeEchoServer(onHit: (req: http.IncomingMessage, body: string) => void) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      onHit(req, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
}

async function main() {
  const logger = new Logger('trigger-smoke');
  const prisma = new PrismaService();
  await prisma.$connect();

  // ---- 手搓依赖图（同 digest-smoke.ts 的 Nest-free 路径）----
  const config = new (require('@nestjs/config').ConfigService)();
  const snapshotV2 = new SnapshotV2Service(
    require('@bourse/analysis').createYahooFinanceConnector(),
    require('@bourse/analysis').createCnFinanceConnector(),
    require('@bourse/analysis').createSecEdgarXbrlFinancialsConnector({ userAgent: SEC_UA }),
    require('@bourse/analysis').createEastmoneyFinancialsConnector(),
    require('@bourse/analysis').createEastmoneyHkFinancialsConnector(),
    require('@bourse/analysis').createSecEdgarFilingsConnector({ userAgent: SEC_UA }),
    require('@bourse/analysis').createCnFilingsConnector(),
  );
  const providerFactory = new ProviderFactoryService(config);
  const aiSettings = new AiSettingsService(prisma, config);
  const generator = new DigestGeneratorService(prisma, snapshotV2, providerFactory, aiSettings, config);
  const subs = new DigestSubscriptionService(prisma);
  const delivery = new DigestDeliveryService(
    prisma,
    subs,
    new WebhookAdapter(),
    new FeishuAdapter(),
    new TelegramAdapter(),
  );
  const trigger = new DigestTriggerService(prisma, generator, delivery);

  try {
    const user = await prisma.user.findUnique({ where: { githubId: TEST_GITHUB_ID } });
    if (!user) {
      logger.error('digest-smoke 用户不存在，先跑 digest-smoke.ts seed');
      process.exit(1);
    }

    // ---- 起 echo server ----
    const PORT = 47771;
    let hits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = makeEchoServer((req, body) => {
      hits.push({ headers: req.headers, body });
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
    logger.log(`echo server :${PORT}`);

    // ---- seed 订阅（指向本地 webhook）----
    await prisma.digestSubscription.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        enabled: true,
        markets: ['US'],
        sessions: ['PRE', 'POST'],
        channels: [{ type: 'WEBHOOK', url: `http://localhost:${PORT}/hook`, secret: WEBHOOK_SECRET }],
      },
      update: {
        enabled: true,
        markets: ['US'],
        sessions: ['PRE', 'POST'],
        channels: [{ type: 'WEBHOOK', url: `http://localhost:${PORT}/hook`, secret: WEBHOOK_SECRET }],
      },
    });
    // 清掉旧的 SENT 记录，确保第一次跑是「未发过」
    await prisma.deliveryRecord.deleteMany({ where: { userId: user.id, market: 'US', session: 'PRE' } });
    logger.log('seeded subscription (US PRE/POST → local webhook)');

    // ---- 第一次：应命中窗口 + 投递 ----
    logger.log(`① runHeartbeat(@ ${US_PRE_MOMENT.toISOString()}) — 期望投递 1 条`);
    const r1 = await trigger.runHeartbeat(US_PRE_MOMENT);
    logger.log(`   结果: ${JSON.stringify(r1)}`);
    await sleep(200); // 等 HTTP 投递落 echo server
    logger.log(`   echo server 收到 ${hits.length} 条`);

    if (hits.length !== 1) {
      logger.error(`❌ 预期收到 1 条 webhook，实际 ${hits.length}`);
    } else {
      const sig = hits[0].headers['x-bourse-signature'] as string | undefined;
      const expectedSig = `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(hits[0].body).digest('hex')}`;
      const payload = JSON.parse(hits[0].body);
      logger.log(`   ✅ 收到 webhook：market=${payload.market} session=${payload.session} 签名=${sig === expectedSig ? '✓ HMAC 验签通过' : '✗ 不匹配'}`);
      logger.log(`      大盘解读: ${payload.marketOverview.interpretation?.slice(0, 50)}…`);
    }
    const sent1 = await prisma.deliveryRecord.count({ where: { userId: user.id, market: 'US', session: 'PRE', status: 'SENT' } });
    logger.log(`   DeliveryRecord SENT 数 = ${sent1}`);

    // 生产中 attemptedAt（真实 wall-clock）与窗口 localYmd 同日（runHeartbeat 用
    // now，不跨交易所日界）。本 smoke 用「未来窗口时刻」跑，attemptedAt 落在真实
    // now（今天）而 localYmd 是 2026-07-06，跨日 → alreadySent 查不到。校准
    // attemptedAt 到 localYmd 当天以模拟生产 wall-clock，验证幂等逻辑本身。
    await prisma.deliveryRecord.updateMany({
      where: { userId: user.id, market: 'US', session: 'PRE', status: 'SENT' },
      data: { attemptedAt: US_PRE_MOMENT },
    });
    logger.log('   校准 SENT 记录 attemptedAt → 窗口时刻（模拟生产 wall-clock）');

    // ---- 第二次：同样时刻 → 幂等，应跳过 ----
    hits = [];
    logger.log(`② 再跑同样时刻 — 期望幂等跳过（skipped=1，不投递）`);
    const r2 = await trigger.runHeartbeat(US_PRE_MOMENT);
    logger.log(`   结果: ${JSON.stringify(r2)}`);
    await sleep(200);
    logger.log(`   echo server 新收到 ${hits.length} 条（应为 0）`);
    if (hits.length === 0) logger.log('   ✅ 幂等生效：未重复投递');
    else logger.error(`   ❌ 幂等失效：重复投递了 ${hits.length} 条`);

    // ---- 不命中窗口的时刻 → no-op ----
    hits = [];
    const offMoment = new Date(Date.UTC(2026, 6, 6, 18, 0)); // 14:00 ET，盘中，不命中
    logger.log(`③ runHeartbeat(@ ${offMoment.toISOString()}) — 期望不命中窗口，no-op`);
    const r3 = await trigger.runHeartbeat(offMoment);
    logger.log(`   结果: ${JSON.stringify(r3)}（应为空数组）`);
    if (r3.length === 0) logger.log('   ✅ 盘中时刻不命中，no-op');
    else logger.error('   ❌ 盘中不应命中窗口');
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
