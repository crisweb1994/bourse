#!/usr/bin/env tsx
/**
 * RFC-10 P5 — Selective Judge smoke script.
 *
 * Bootstraps the apps/api Nest context, runs a small basket of CN A-share
 * COMPREHENSIVE analyses through the production path, then reads each
 * AnalysisSection.structuredJson.judgeResult sub-field + the run-level
 * RunAggregate row to surface:
 *
 *   - Which dims triggered the judge (shouldJudge → runJudge ran)
 *   - judgeResult.pass / confidenceAdjustment per triggered dim
 *   - run-level total cost (LLM dims + Stage A tools + judge LLM)
 *
 * Confidence-downgrade attribution is observable indirectly via the
 * `judgeResult.confidenceAdjustment` field; the side effect on
 * `section.structuredJson.conclusion.confidence` is already applied at
 * DB write time (RFC-10 P4).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... \
 *     pnpm -F @bourse/api judge:smoke -- \
 *       [--symbols 600519.SS,002594.SZ] \
 *       [--output rfc10-judge-smoke.json] [--provider claude]
 *
 * Cost: real LLM. Each COMPREHENSIVE run is ~$0.10-0.50; judge adds
 * ~$0.01-0.06 (RFC-10 §7.3). Requires docker postgres + ANTHROPIC_API_KEY.
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

const PARITY_USER_GITHUB_ID = 'rfc10-judge-smoke-bot';

interface CliArgs {
  symbols: string[];
  output: string;
  provider: string | undefined;
}

interface DimReport {
  type: string;
  status: string;
  signal: string | null;
  confidence: string | null;
  judgeTriggered: boolean;
  judgePass: boolean | null;
  judgeConfidenceAdjustment: string | null;
  judgeConcerns: string[];
}

interface RunReport {
  symbol: string;
  analysisId: string;
  status: string;
  totalLatencyMs: number;
  totalCostUsd: number;
  totalLlmCalls: number;
  factConflictCount: number;
  dims: DimReport[];
  errorMessage?: string;
}

function parseCli(): CliArgs {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      symbols: { type: 'string' },
      output: { type: 'string', default: 'rfc10-judge-smoke.json' },
      provider: { type: 'string' },
    },
    strict: true,
  });
  const symbols = values.symbols
    ? values.symbols.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_BASKET.map((s) => s.symbol);
  return {
    symbols,
    output: values.output ?? 'rfc10-judge-smoke.json',
    provider: values.provider,
  };
}

async function ensureSmokeUser(prisma: PrismaService) {
  return prisma.user.upsert({
    where: { githubId: PARITY_USER_GITHUB_ID },
    create: {
      githubId: PARITY_USER_GITHUB_ID,
      name: 'RFC-10 Judge Smoke Bot',
      email: 'rfc10-judge-smoke@local',
    },
    update: {},
  });
}

async function ensureStock(prisma: PrismaService, symbol: string) {
  const known = DEFAULT_BASKET.find((s) => s.symbol === symbol);
  const name = known?.name ?? symbol;
  const exchange =
    known?.exchange ?? (symbol.endsWith('.SS') ? 'SSE' : 'SZSE');
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
  const analysis = await svc.create(userId, {
    stockId,
    analysisType: 'COMPREHENSIVE',
    ...(provider ? { aiProvider: provider } : {}),
  } as Parameters<AnalysisService['create']>[1]);
  try {
    await svc.runAnalysis(analysis.id, noopSse);
    return { analysisId: analysis.id };
  } catch (err) {
    return { analysisId: analysis.id, errorMessage: (err as Error).message };
  }
}

async function readRunReport(
  prisma: PrismaService,
  analysisId: string,
  symbol: string,
  errorMessage?: string,
): Promise<RunReport> {
  const [agg, analysis] = await Promise.all([
    prisma.runAggregate.findUnique({ where: { analysisId } }),
    prisma.analysis.findUnique({
      where: { id: analysisId },
      include: { sections: { orderBy: { order: 'asc' } } },
    }),
  ]);

  const dims: DimReport[] = (analysis?.sections ?? []).map((s) => {
    const sj = s.structuredJson as
      | {
          conclusion?: { signal?: string; confidence?: string };
          judgeResult?: {
            pass?: boolean;
            confidenceAdjustment?: string;
            concerns?: string[];
          };
        }
      | null;
    const j = sj?.judgeResult;
    return {
      type: s.type,
      status: s.status,
      signal: sj?.conclusion?.signal ?? null,
      confidence: sj?.conclusion?.confidence ?? null,
      judgeTriggered: j !== undefined && j !== null,
      judgePass: j?.pass ?? null,
      judgeConfidenceAdjustment: j?.confidenceAdjustment ?? null,
      judgeConcerns: j?.concerns ?? [],
    };
  });

  return {
    symbol,
    analysisId,
    status: agg?.status ?? analysis?.status ?? 'UNKNOWN',
    totalLatencyMs: agg?.totalLatencyMs ?? 0,
    totalCostUsd: Number(agg?.totalCostUsd ?? 0),
    totalLlmCalls: agg?.totalLlmCalls ?? 0,
    factConflictCount: agg?.factConflictCount ?? 0,
    dims,
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

function printReport(reports: RunReport[]): void {
  const line = '─'.repeat(85);
  console.log(`\n${line}`);
  console.log(' RFC-10 Selective Judge Smoke Report');
  console.log(line);
  for (const r of reports) {
    console.log(`\n▶ ${r.symbol}  status=${r.status}  latency=${fmtMs(r.totalLatencyMs)}  cost=$${r.totalCostUsd.toFixed(4)}  llmCalls=${r.totalLlmCalls}`);
    if (r.errorMessage) {
      console.log(`  ✘ ${r.errorMessage}`);
      continue;
    }
    console.log(
      `  ${pad('dim', 14)} ${pad('signal', 8)} ${pad('conf', 7)} ${pad('judge', 7)} ${pad('pass', 5)} ${pad('adjust', 22)} concerns`,
    );
    for (const d of r.dims) {
      console.log(
        `  ${pad(d.type, 14)} ${pad(d.signal ?? '-', 8)} ${pad(d.confidence ?? '-', 7)} ` +
          `${pad(d.judgeTriggered ? 'YES' : '-', 7)} ${pad(d.judgePass === null ? '-' : d.judgePass ? 'YES' : 'NO', 5)} ` +
          `${pad(d.judgeConfidenceAdjustment ?? '-', 22)} ${d.judgeConcerns.length}`,
      );
    }
  }

  console.log(`\n${line}`);
  console.log(' Aggregates (RFC-10 §7.3 cost overhead target: +5-15% vs baseline)');
  console.log(line);
  const total = reports.length;
  const triggeredCounts = reports.map(
    (r) => r.dims.filter((d) => d.judgeTriggered).length,
  );
  const triggeredTotal = triggeredCounts.reduce((a, b) => a + b, 0);
  const downgradedTotal = reports
    .flatMap((r) => r.dims)
    .filter(
      (d) =>
        d.judgeTriggered &&
        d.judgeConfidenceAdjustment &&
        d.judgeConfidenceAdjustment !== 'KEEP',
    ).length;
  console.log(
    `  runs:                      ${total}`,
  );
  console.log(
    `  judge triggers (total):    ${triggeredTotal} across ${total} runs (avg ${
      total > 0 ? (triggeredTotal / total).toFixed(1) : '0'
    } dims/run)`,
  );
  console.log(
    `  judge downgrades:          ${downgradedTotal}/${triggeredTotal} triggered`,
  );
  const totalCost = reports.reduce((s, r) => s + r.totalCostUsd, 0);
  console.log(
    `  total cost across runs:    $${totalCost.toFixed(4)} (avg $${(total > 0 ? totalCost / total : 0).toFixed(4)} / run)`,
  );
  console.log();
}

async function main(): Promise<void> {
  const cli = parseCli();
  const logger = new Logger('rfc10-judge-smoke');
  logger.log(`symbols=[${cli.symbols.join(', ')}]`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const svc = app.get(AnalysisService);
  const prisma = app.get(PrismaService);

  try {
    const user = await ensureSmokeUser(prisma);
    const reports: RunReport[] = [];
    for (const symbol of cli.symbols) {
      const stock = await ensureStock(prisma, symbol);
      logger.log(`▶ ${symbol}`);
      const { analysisId, errorMessage } = await runOne(
        svc,
        user.id,
        stock.id,
        cli.provider,
      );
      const r = await readRunReport(prisma, analysisId, symbol, errorMessage);
      reports.push(r);
      const triggered = r.dims.filter((d) => d.judgeTriggered).length;
      logger.log(
        `  ✓ ${analysisId}  status=${r.status}  judge triggered=${triggered}/${r.dims.length}  cost=$${r.totalCostUsd.toFixed(4)}`,
      );
    }

    printReport(reports);

    await writeFile(
      cli.output,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), cli, reports },
        null,
        2,
      ),
    );
    logger.log(`Wrote ${reports.length} reports → ${cli.output}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
