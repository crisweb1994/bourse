#!/usr/bin/env tsx
/**
 * RFC-08 P5 — DEBATE uplift parity script.
 *
 * Drives apps/api `AnalysisService.createDebate + runAnalysis` against
 * the same CN A-share multiple times and reads back `RunAggregate` to
 * verify the P1-P4 outcomes in one shot:
 *
 *  P1 (v2 EvidencePack):  adapter wires gateway/marketProfile for CN —
 *                         visible indirectly via cost drop on stage A.
 *  P3 (RunAggregate):     every run produces a RunAggregate row with
 *                         analysisType='DEBATE'. Used to be invisible.
 *  P4 (Prompt cache):     2nd+ same-stock run within Anthropic's
 *                         ephemeral window (5min) sees
 *                         totalCacheReadTokens > 0; total cost drops.
 *                         Prompt cache is permanently on (no toggle).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... \
 *     pnpm -F @bourse/api parity:rfc08 -- \
 *       [--symbols 600519.SS,002594.SZ] \
 *       [--runs 3] \
 *       [--output rfc08-debate-parity.json] [--provider claude]
 *
 * Cost: real LLM. DEBATE is ~3 LLM calls/round × 2 rounds + 1 judge =
 * ~7 calls per run. Budget ~$0.10-0.30 per run.
 *
 * Requires docker postgres up (port 5434) and ANTHROPIC_API_KEY set.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { AnalysisService } from '../src/analysis/analysis.service';
import { PrismaService } from '../src/prisma/prisma.service';

const DEFAULT_BASKET = [
  { symbol: '600519.SS', name: '贵州茅台', exchange: 'SSE' },
  { symbol: '002594.SZ', name: '比亚迪', exchange: 'SZSE' },
] as const;

const PARITY_USER_GITHUB_ID = 'rfc08-debate-parity-bot';

interface CliArgs {
  symbols: string[];
  runs: number;
  output: string;
  provider: string | undefined;
}

interface RunRecord {
  symbol: string;
  runIndex: number;
  analysisId: string;
  status: string;
  overallSignal: string | null;
  overallConfidence: string | null;
  totalLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalLlmCalls: number;
  totalCostUsd: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  errorMessage?: string;
}

function parseCli(): CliArgs {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      symbols: { type: 'string' },
      runs: { type: 'string', default: '3' },
      output: { type: 'string', default: 'rfc08-debate-parity.json' },
      provider: { type: 'string' },
    },
    strict: true,
  });

  const symbols = values.symbols
    ? values.symbols.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_BASKET.map((s) => s.symbol);
  const runs = Math.max(1, Number(values.runs));
  if (!Number.isFinite(runs)) {
    console.error(`--runs must be a positive integer, got: ${values.runs}`);
    process.exit(1);
  }

  return {
    symbols,
    runs,
    output: values.output ?? 'rfc08-debate-parity.json',
    provider: values.provider,
  };
}

async function ensureParityUser(prisma: PrismaService) {
  return prisma.user.upsert({
    where: { githubId: PARITY_USER_GITHUB_ID },
    create: {
      githubId: PARITY_USER_GITHUB_ID,
      name: 'RFC-08 DEBATE Parity Bot',
      email: 'rfc08-debate-parity@local',
    },
    update: {},
  });
}

async function ensureStock(prisma: PrismaService, symbol: string) {
  const known = DEFAULT_BASKET.find((s) => s.symbol === symbol);
  const name = known?.name ?? symbol;
  const exchange = known?.exchange ?? (symbol.endsWith('.SS') ? 'SSE' : 'SZSE');
  return prisma.stock.upsert({
    where: { symbol_market: { symbol, market: 'CN' } },
    create: { symbol, name, market: 'CN', exchange, currency: 'CNY' },
    update: {},
  });
}

const noopSse: (event: string, payload: unknown) => void = () => {};

async function runOne(
  svc: AnalysisService,
  userId: string,
  stockId: string,
  provider: string | undefined,
): Promise<{ analysisId: string; errorMessage?: string }> {
  const analysis = await svc.createDebate(userId, {
    stockId,
    bullId: 'buffett',
    bearId: 'burry',
    rounds: 2,
    ...(provider ? { aiProvider: provider } : {}),
  } as Parameters<AnalysisService['createDebate']>[1]);
  try {
    await svc.runAnalysis(analysis.id, noopSse);
    return { analysisId: analysis.id };
  } catch (err) {
    return { analysisId: analysis.id, errorMessage: (err as Error).message };
  }
}

async function readRunRecord(
  prisma: PrismaService,
  analysisId: string,
  symbol: string,
  runIndex: number,
  errorMessage?: string,
): Promise<RunRecord> {
  const [agg, analysis] = await Promise.all([
    prisma.runAggregate.findUnique({ where: { analysisId } }),
    prisma.analysis.findUnique({ where: { id: analysisId } }),
  ]);
  if (!agg) {
    return {
      symbol,
      runIndex,
      analysisId,
      status: analysis?.status ?? 'UNKNOWN',
      overallSignal: null,
      overallConfidence: null,
      totalLatencyMs: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalLlmCalls: 0,
      totalCostUsd: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }
  return {
    symbol,
    runIndex,
    analysisId,
    status: agg.status,
    overallSignal: agg.overallSignal,
    overallConfidence: agg.overallConfidence,
    totalLatencyMs: agg.totalLatencyMs,
    totalTokensIn: agg.totalTokensIn,
    totalTokensOut: agg.totalTokensOut,
    totalLlmCalls: agg.totalLlmCalls,
    totalCostUsd: Number(agg.totalCostUsd),
    totalCacheReadTokens: agg.totalCacheReadTokens,
    totalCacheCreationTokens: agg.totalCacheCreationTokens,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pad(s: string | number, w: number): string {
  return String(s).padEnd(w);
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function printDiffTable(records: RunRecord[]): void {
  const line = '─'.repeat(85);
  console.log(`\n${line}`);
  console.log(' RFC-08 P5 DEBATE Uplift Parity Report');
  console.log(line);

  const symbols = [...new Set(records.map((r) => r.symbol))];
  for (const symbol of symbols) {
    const rs = records
      .filter((r) => r.symbol === symbol)
      .sort((a, b) => a.runIndex - b.runIndex);
    console.log(`\n▶ ${symbol}`);
    console.log(
      `  ${pad('run', 4)} ${pad('signal', 8)} ${pad('conf', 7)} ` +
        `${pad('latency', 10)} ${pad('llm', 4)} ${pad('cacheR', 9)} ${pad('cacheC', 9)} ${pad('cost', 9)}`,
    );
    for (const r of rs) {
      const row =
        `  ${pad(r.runIndex, 4)} ` +
        `${pad(r.overallSignal ?? '-', 8)} ${pad(r.overallConfidence ?? '-', 7)} ` +
        `${pad(fmtMs(r.totalLatencyMs), 10)} ${pad(r.totalLlmCalls, 4)} ` +
        `${pad(r.totalCacheReadTokens.toLocaleString(), 9)} ` +
        `${pad(r.totalCacheCreationTokens.toLocaleString(), 9)} ` +
        `$${r.totalCostUsd.toFixed(4)}`;
      console.log(row + (r.errorMessage ? `  ✘ ${r.errorMessage}` : ''));
    }

    if (rs.length >= 2) {
      const cost = avg(rs.map((r) => r.totalCostUsd));
      const cacheR = avg(rs.map((r) => r.totalCacheReadTokens));
      const cacheC = avg(rs.map((r) => r.totalCacheCreationTokens));
      console.log(
        `  avg  cost $${cost.toFixed(4)}   ` +
          `cacheR avg ${cacheR.toFixed(0)}   cacheCreate avg ${cacheC.toFixed(0)}`,
      );
    }
  }

  console.log(`\n${line}`);
  console.log(' Gate checks (RFC-08 §9.1)');
  console.log(line);
  const allDebateRows = records.filter((r) => r.status !== 'UNKNOWN');
  const cacheHits = records.filter((r) => r.totalCacheReadTokens > 0).length;
  // 2nd+ same-stock runs should hit cache (1st run creates it).
  const secondPlus = records.filter((r) => r.runIndex >= 2);
  const secondPlusHits = secondPlus.filter(
    (r) => r.totalCacheReadTokens > 0,
  ).length;
  console.log(
    `  RunAggregate written for DEBATE: ${allDebateRows.length}/${records.length}   ` +
      `(P3: DEBATE visible in telemetry)`,
  );
  console.log(
    `  runs with cacheR > 0: ${cacheHits}/${records.length}   ` +
      `(P4: prompt cache wired)`,
  );
  if (secondPlus.length > 0) {
    console.log(
      `  2nd+ runs with cacheR > 0: ${secondPlusHits}/${secondPlus.length}   ` +
        `(P4: ephemeral cache reused across same-stock reruns within 5min)`,
    );
  }
  console.log();
}

async function main(): Promise<void> {
  const cli = parseCli();
  const logger = new Logger('rfc08-debate-parity');
  logger.log(
    `symbols=[${cli.symbols.join(', ')}] runs=${cli.runs}`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const svc = app.get(AnalysisService);
  const prisma = app.get(PrismaService);

  try {
    const user = await ensureParityUser(prisma);
    const stocks = new Map<string, { id: string }>();
    for (const sym of cli.symbols) {
      const stock = await ensureStock(prisma, sym);
      stocks.set(sym, stock);
    }

    const records: RunRecord[] = [];
    for (const symbol of cli.symbols) {
      const stock = stocks.get(symbol);
      if (!stock) continue;
      for (let i = 1; i <= cli.runs; i++) {
        logger.log(`▶ ${symbol}  run=${i}/${cli.runs}`);
        const { analysisId, errorMessage } = await runOne(
          svc,
          user.id,
          stock.id,
          cli.provider,
        );
        const rec = await readRunRecord(
          prisma,
          analysisId,
          symbol,
          i,
          errorMessage,
        );
        records.push(rec);
        logger.log(
          `  ✓ ${analysisId} status=${rec.status} latency=${fmtMs(rec.totalLatencyMs)} ` +
            `cost=$${rec.totalCostUsd.toFixed(4)} cacheR=${rec.totalCacheReadTokens} ` +
            `cacheC=${rec.totalCacheCreationTokens}`,
        );
      }
    }

    printDiffTable(records);

    await writeFile(
      cli.output,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), cli, records },
        null,
        2,
      ),
    );
    logger.log(`Wrote ${records.length} records → ${cli.output}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
