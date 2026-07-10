#!/usr/bin/env tsx
/**
 * Daily Brief · DigestGenerator 真实数据 smoke（task5 自测用，不进生产路径）。
 *
 * 单测全是 stub，覆盖不到：Yahoo/东财真实拉数、用户 provider 真调 LLM、
 * zod BriefPayload 在真实数据形状上 parse、漂移在真实 history 上计算。
 * 本脚本直接拿 Nest DI 调 generate() 验证这些。
 *
 * 用法（在 apps/api 目录下）：
 *   # 1. 先备好环境：起 DB + 填 .env（DATABASE_URL / AI key）
 *   docker compose up -d postgres        # 或你本地的 pg
 *   pnpm db:push                          # 同步 schema
 *
 *   # 2. 一条龙：seed 测试数据 + 跑 generate + 打印 BriefPayload
 *   pnpm -F @bourse/api exec tsx scripts/digest-smoke.ts
 *
 *   # 可选参数：
 *   pnpm -F @bourse/api exec tsx scripts/digest-smoke.ts -- --market US --session POST
 *   pnpm -F @bourse/api exec tsx scripts/digest-smoke.ts -- --no-seed      # 只跑，不造数据
 *   pnpm -F @bourse/api exec tsx scripts/digest-smoke.ts -- --degrade      # 不写 provider，验证降级纯数字
 *
 * 为什么不用 AppModule？createApplicationContext(AppModule) 会实例化 AuthModule
 * 里的 GithubStrategy（passport 构造期即读 ConfigService），在 standalone context
 * 下会抛 NPE（与 task5 无关的既有 bootstrap 约束）。这里用一个只挂 DigestGenerator
 * 真正依赖的子模块图的 SmokeRootModule（AnalysisModule + AiSettingsModule +
 * ConfigModule + Prisma），绕开 AuthModule，照旧走真实 DI（PrismaService /
 * SnapshotV2Service / ProviderFactoryService / AiSettingsService 全是生产实例）。
 *
 * seed 造的数据（幂等 upsert，可重复跑）：
 *   - 1 个测试用户（githubId=digest-smoke）
 *   - 该用户 1 条默认 AiProviderSetting（从 .env 的 AI key + provider/model 读）
 *   - 3 只自选股（US: AAPL/MSFT/NVDA；CN: 600519/000858/300750）
 *   - 第一只票一条 35 天前的 COMPREHENSIVE Analysis → 触发 drift + stale 异动
 *
 * 不删数据、不调推送（task6）、不落库 Brief（task5 职责只到生成 BriefPayload）。
 */
import { parseArgs } from 'node:util';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as dotenv from 'dotenv';
import {
  createCnFilingsConnector,
  createCnFinanceConnector,
  createEastmoneyFinancialsConnector,
  createEastmoneyHkFinancialsConnector,
  createSecEdgarFilingsConnector,
  createSecEdgarXbrlFinancialsConnector,
  createYahooFinanceConnector,
} from '@bourse/analysis';
import { DigestGeneratorService } from '../src/digest/brief.generator';
import { PrismaService } from '../src/prisma/prisma.service';
import { SnapshotV2Service } from '../src/analysis/snapshot-v2.service';
import { ProviderFactoryService } from '../src/analysis/provider-factory.service';
import { AiSettingsService } from '../src/ai-settings/ai-settings.service';

// 加载根 .env → process.env，与 AppModule 的 envFilePath 顺序一致（.env.local
// 优先）。dotenv 默认不覆盖已有值，所以先加载的文件胜出 → 先 .env.local。
dotenv.config({ path: '../../.env.local' });
dotenv.config({ path: '../../.env' });

const SEC_UA =
  process.env.RESEARCH_CORE_USER_AGENT?.trim() ||
  'stock-suggest-smoke contact@example.com';

// ---- CLI ----
const { values } = parseArgs({
  options: {
    market: { type: 'string', default: 'US' },
    session: { type: 'string', default: 'POST' },
    'no-seed': { type: 'boolean', default: false },
    degrade: { type: 'boolean', default: false },
  },
  strict: true,
});
const market = (values.market as 'US' | 'CN' | 'HK') ?? 'US';
const session = (values.session as 'PRE' | 'POST') ?? 'POST';
const doSeed = values['no-seed'] !== true;
const degrade = values.degrade === true;

const TEST_GITHUB_ID = 'digest-smoke';
const TEST_STOCKS: { symbol: string; name: string; sector: string }[] =
  market === 'CN'
    ? // CN connector（tencent/eastmoney）期望纯数字 code（parseInstrumentId 解析
      // CN:600519）；带 .SS/.SZ 后缀会被判 INVALID_INSTRUMENT → price=NaN。DB 里
      // 已有的 CN 自选（如 000725）也是纯数字，与此一致。
      [
        { symbol: '600519', name: '贵州茅台', sector: '白酒' },
        { symbol: '000858', name: '五粮液', sector: '白酒' },
        { symbol: '300750', name: '宁德时代', sector: '电力设备' },
      ]
    : [
        { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology' },
        { symbol: 'MSFT', name: 'Microsoft Corp.', sector: 'Technology' },
        { symbol: 'NVDA', name: 'NVIDIA Corp.', sector: 'Semiconductor' },
      ];

async function seed(prisma: PrismaService, logger: Logger): Promise<string> {
  // 1. 测试用户（幂等）
  const user = await prisma.user.upsert({
    where: { githubId: TEST_GITHUB_ID },
    create: { githubId: TEST_GITHUB_ID, name: 'Digest Smoke', email: 'digest-smoke@test.local' },
    update: {},
  });

  // 2. AiProviderSetting（从 .env 读；--degrade 则跳过 → 验证降级路径）
  if (!degrade) {
    // .env 键名对齐根 .env（source of truth）：AI_PROVIDER="openai"|…，
    // OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL (primary)。
    // OPENAI_JSON_MODEL 可选（utility 档），缺省回退 primary。
    const rawProvider = (process.env.AI_PROVIDER ?? 'openai').toLowerCase();
    const providerType: 'ANTHROPIC' | 'OPENAI_COMPATIBLE' =
      rawProvider === 'anthropic' ? 'ANTHROPIC' : 'OPENAI_COMPATIBLE';
    const apiKey =
      process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY;
    const baseUrl =
      process.env.AI_BASE_URL ??
      (providerType === 'ANTHROPIC' ? undefined : process.env.OPENAI_BASE_URL);
    const primaryModel =
      process.env.AI_MODEL ??
      process.env.OPENAI_MODEL ??
      (providerType === 'ANTHROPIC' ? 'claude-3-5-sonnet-latest' : 'gpt-4o');
    const utilityModel =
      process.env.AI_UTILITY_MODEL ??
      process.env.OPENAI_JSON_MODEL ??
      (providerType === 'ANTHROPIC' ? 'claude-3-5-haiku-latest' : primaryModel);

    if (!apiKey) {
      logger.warn(
        'No AI key in env (ANTHROPIC_API_KEY/OPENAI_API_KEY/AI_API_KEY) — 将走降级路径',
      );
    } else {
      await prisma.aiProviderSetting.upsert({
        where: { id: `${TEST_GITHUB_ID}-provider` },
        create: {
          id: `${TEST_GITHUB_ID}-provider`,
          userId: user.id,
          label: 'Digest Smoke Provider',
          providerType,
          apiKey,
          baseUrl,
          enabledModels: [primaryModel, ...(utilityModel && utilityModel !== primaryModel ? [utilityModel] : [])],
          primaryModel,
          utilityModel,
          isDefault: true,
          enabled: true,
        },
        update: { apiKey, baseUrl, primaryModel, utilityModel, isDefault: true, enabled: true },
      });
      logger.log(`seeded provider: ${providerType} / ${primaryModel} + ${utilityModel}`);
    }
  } else {
    // 显式降级：把已有 setting 置为非默认/禁用
    await prisma.aiProviderSetting.updateMany({
      where: { userId: user.id },
      data: { isDefault: false, enabled: false },
    });
    logger.log('degrade mode: 所有 provider 已禁用 → generate 应走纯数字');
  }

  // 3. Stocks + Watchlist（幂等）
  for (const s of TEST_STOCKS) {
    const stock = await prisma.stock.upsert({
      where: { symbol_market: { symbol: s.symbol, market } },
      create: {
        symbol: s.symbol,
        name: s.name,
        market,
        exchange: market === 'CN' ? 'CN' : market === 'HK' ? 'HK' : 'US',
        currency: market === 'CN' ? 'CNY' : market === 'HK' ? 'HKD' : 'USD',
        sector: s.sector,
      },
      update: { sector: s.sector },
    });
    await prisma.watchlistItem.upsert({
      where: { userId_stockId: { userId: user.id, stockId: stock.id } },
      create: { userId: user.id, stockId: stock.id, order: TEST_STOCKS.indexOf(s) },
      update: {},
    });
  }
  logger.log(`seeded ${TEST_STOCKS.length} stocks + watchlist for ${market}`);

  // 4. 第一只票造一条 35 天前的 Analysis（触发 drift + stale 异动）
  const staleAt = new Date(Date.now() - 35 * 86_400_000);
  const staleDay = staleAt.toISOString().slice(0, 10);
  const firstStock = await prisma.stock.findUnique({
    where: { symbol_market: { symbol: TEST_STOCKS[0]!.symbol, market } },
  });
  if (firstStock) {
    // id 跟 market 绑定，且 update 分支也更新 symbol/stockId，保证每个 market 的
    // 第一只票都有自己的 stale Analysis（否则跨 market 复用同 id 会一直指向
    // 首跑 market 的票，导致其它 market 的票 drift 始终 null）。
    const analysisId = `${TEST_GITHUB_ID}-analysis-${market}`;
    await prisma.analysis.upsert({
      where: { id: analysisId },
      create: {
        id: analysisId,
        userId: user.id,
        stockId: firstStock.id,
        symbol: firstStock.symbol,
        market,
        analysisType: 'COMPREHENSIVE',
        status: 'COMPLETED',
        overallSignal: 'BULLISH',
        overallConfidence: 'MEDIUM',
        dataAsOf: staleDay,
        generatedAt: staleAt,
        summaryMarkdown: '（smoke seed）35 天前的分析，用于验证 drift/stale 异动',
        createdAt: staleAt,
      },
      update: {
        stockId: firstStock.id,
        symbol: firstStock.symbol,
        market,
        dataAsOf: staleDay,
        generatedAt: staleAt,
        createdAt: staleAt,
      },
    });
    logger.log(`seeded stale Analysis (dataAsOf=${staleDay}, 35d ago) on ${firstStock.symbol}`);
  }

  return user.id;
}

async function main(): Promise<void> {
  const logger = new Logger('digest-smoke');

  // 手搓依赖图（绕开 AppModule → AuthModule → passport 的 standalone NPE）。
  // 走的仍是生产类：PrismaService / SnapshotV2Service / ProviderFactoryService /
  // AiSettingsService 全是真实实例，端口连真实 Yahoo/东财/SEC。只是 DI 手动接线。
  const config = new ConfigService();
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    const snapshotV2 = new SnapshotV2Service(
      createYahooFinanceConnector() as any,
      createCnFinanceConnector() as any,
      createSecEdgarXbrlFinancialsConnector({ userAgent: SEC_UA }) as any,
      createEastmoneyFinancialsConnector() as any,
      createEastmoneyHkFinancialsConnector() as any,
      createSecEdgarFilingsConnector({ userAgent: SEC_UA }) as any,
      createCnFilingsConnector() as any,
    );
    const providerFactory = new ProviderFactoryService(config);
    const aiSettings = new AiSettingsService(prisma, config);
    const generator = new DigestGeneratorService(
      prisma,
      snapshotV2,
      providerFactory,
      aiSettings,
      config,
    );

    const userId = doSeed
      ? await seed(prisma, logger)
      : (
          await prisma.user.findUnique({ where: { githubId: TEST_GITHUB_ID } })
        )?.id;

    if (!userId) {
      logger.error('No test user found — run without --no-seed first, or it was deleted.');
      process.exit(1);
    }

    logger.log(`→ generate(userId=${userId}, market=${market}, session=${session})`);
    const t0 = Date.now();
    const brief = await generator.generate(userId, market, session);
    const ms = Date.now() - t0;

    console.log('\n========== BriefPayload ==========\n');
    console.log(JSON.stringify(brief, null, 2));
    console.log('\n==================================');
    logger.log(
      `done in ${ms}ms — indices=${brief.marketOverview.indices.length} ` +
        `items=${brief.watchlist.items.length} ` +
        `market.interpretation=${brief.marketOverview.interpretation ? 'YES' : 'null(degraded)'} ` +
        `watchlist.interpretation=${brief.watchlist.interpretation ? 'YES' : 'null(degraded)'} ` +
        `deepDives=${brief.watchlist.items.filter((i) => i.deepDive).length}`,
    );

    // 关键不变式自检（真实数据上）
    const drifts = brief.watchlist.items
      .filter((i) => i.driftSinceLastAnalysis !== null)
      .map((i) => `${i.symbol}: ${i.driftSinceLastAnalysis!.toFixed(2)}%`);
    logger.log(`driftSinceLastAnalysis 非空项 = ${drifts.join(', ') || '(none)'}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
