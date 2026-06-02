#!/usr/bin/env tsx
/**
 * RFC-01 §6 — Telemetry analysis CLI.
 *
 * Reads SectionTrace + RunAggregate rows from Postgres and prints a
 * console report answering the 5 §7 verification questions:
 *   1. p50/p90 total latency
 *   2. top 3 slowest dimensions
 *   3. avg web_search requests per run
 *   4. web_search error distribution
 *   5. partial-rate / failure-reason distribution
 *
 * Usage:
 *   pnpm telemetry                  # last 7 days (default)
 *   pnpm telemetry --days 30
 *   pnpm telemetry --days 7 --market CN
 *
 * Telemetry-only: no business writes, safe to run anytime.
 */

import { PrismaClient } from '@prisma/client';

interface CliArgs {
  days: number;
  market: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { days: 7, market: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0 || n > 365) {
        throw new Error(`--days must be an integer 1..365, got: ${argv[i]}`);
      }
      args.days = n;
    } else if (a === '--market') {
      const m = argv[++i];
      if (!m || !/^[A-Z]{2,4}$/.test(m)) {
        throw new Error(`--market must be a 2-4 letter code, got: ${m}`);
      }
      args.market = m;
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function pad(s: string | number, w: number): string {
  return String(s).padEnd(w);
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();
  const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);
  const marketFilter = args.market ? ` for market ${args.market}` : '';

  console.log(
    `\n=== Telemetry Report (last ${args.days} days${marketFilter}) ===`,
  );
  console.log(`Window: ${since.toISOString()} → now\n`);

  try {
    // ----- Run-level overview -----
    const runWhere = {
      createdAt: { gte: since },
      ...(args.market ? { market: args.market } : {}),
    };
    const runs = await prisma.runAggregate.findMany({
      where: runWhere,
      orderBy: { createdAt: 'desc' },
    });

    if (runs.length === 0) {
      console.log('No runs in window. (Did anyone run an analysis recently?)');
      return;
    }

    const byStatus = runs.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    const latencies = runs
      .map((r) => r.totalLatencyMs)
      .sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
    const p90 = latencies[Math.floor(latencies.length * 0.9)] ?? 0;

    const totalCost = runs.reduce(
      (s, r) => s + Number(r.totalCostUsd),
      0,
    );
    const avgCost = totalCost / runs.length;

    console.log(`Run-Level Overview`);
    console.log(`  Total runs:    ${runs.length}`);
    console.log(`  Status:        ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`  Total cost:    ${fmtCost(totalCost)}`);
    console.log(`  Avg cost/run:  ${fmtCost(avgCost)}`);
    console.log(`  p50 latency:   ${fmtMs(p50)}`);
    console.log(`  p90 latency:   ${fmtMs(p90)}`);

    // ----- Per-dim slowest 3 -----
    const sectionWhere = {
      createdAt: { gte: since },
      ...(args.market
        ? { analysis: { market: args.market } }
        : {}),
    };
    const sections = await prisma.sectionTrace.findMany({
      where: sectionWhere,
    });

    const byDim = sections.reduce<
      Record<
        string,
        {
          durations: number[];
          costs: number[];
          failures: number;
          total: number;
        }
      >
    >((acc, s) => {
      const k = s.sectionType;
      if (!acc[k]) {
        acc[k] = { durations: [], costs: [], failures: 0, total: 0 };
      }
      acc[k].durations.push(s.durationMs);
      acc[k].costs.push(Number(s.costUsd));
      acc[k].total += 1;
      if (s.status !== 'COMPLETED') acc[k].failures += 1;
      return acc;
    }, {});

    const dimStats = Object.entries(byDim)
      .map(([dim, d]) => {
        const sorted = [...d.durations].sort((a, b) => a - b);
        const dimP50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
        const dimP90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
        const avgC = d.costs.reduce((s, x) => s + x, 0) / d.costs.length;
        return {
          dim,
          p50: dimP50,
          p90: dimP90,
          avgCost: avgC,
          failures: d.failures,
          total: d.total,
        };
      })
      .sort((a, b) => b.p50 - a.p50);

    console.log(`\nPer-Dimension Stats (sorted by p50 latency)`);
    console.log(
      `  ${pad('dim', 14)} ${pad('p50', 10)} ${pad('p90', 10)} ${pad('avg cost', 12)} ${pad('failures', 10)}`,
    );
    for (const s of dimStats) {
      console.log(
        `  ${pad(s.dim, 14)} ${pad(fmtMs(s.p50), 10)} ${pad(fmtMs(s.p90), 10)} ${pad(fmtCost(s.avgCost), 12)} ${pad(`${s.failures}/${s.total}`, 10)}`,
      );
    }

    // ----- Cache -----
    const cacheRead = sections.reduce(
      (s, x) => s + x.cacheReadInputTokens,
      0,
    );
    const cacheCreate = sections.reduce(
      (s, x) => s + x.cacheCreationInputTokens,
      0,
    );
    const totalIn = sections.reduce((s, x) => s + x.tokensIn, 0);
    console.log(`\nCache (Phase 3 not yet on, expect mostly zeros)`);
    console.log(`  cache_read tokens:     ${cacheRead.toLocaleString()}`);
    console.log(`  cache_creation tokens: ${cacheCreate.toLocaleString()}`);
    console.log(
      `  cache hit ratio:       ${
        totalIn > 0 ? ((cacheRead / totalIn) * 100).toFixed(1) : '0.0'
      }%`,
    );

    // ----- Web search -----
    const totalReq = sections.reduce(
      (s, x) => s + x.webSearchRequests,
      0,
    );
    const totalErr = sections.reduce(
      (s, x) => s + x.webSearchErrorsCount,
      0,
    );
    const affectedRuns = new Set(
      sections.filter((s) => s.webSearchErrorsCount > 0).map((s) => s.analysisId),
    ).size;

    console.log(`\nWeb Search`);
    console.log(
      `  Avg requests/run: ${(totalReq / runs.length).toFixed(1)}`,
    );
    console.log(`  Total errors:     ${totalErr}`);
    console.log(
      `  Affected runs:    ${affectedRuns} / ${runs.length} (${
        runs.length > 0 ? ((affectedRuns / runs.length) * 100).toFixed(0) : 0
      }%)`,
    );

    // Error code breakdown from JSON column
    const codeCount: Record<string, number> = {};
    for (const s of sections) {
      const errs = s.webSearchErrors as Array<{ code: string }> | null;
      if (!errs) continue;
      for (const e of errs) {
        codeCount[e.code] = (codeCount[e.code] ?? 0) + 1;
      }
    }
    if (Object.keys(codeCount).length > 0) {
      console.log(`  Error code breakdown:`);
      for (const [code, n] of Object.entries(codeCount).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`    ${pad(code, 22)} ${n}`);
      }
    }

    // ----- Failure summary -----
    const failedRuns = runs.filter((r) => r.status !== 'COMPLETED');
    if (failedRuns.length > 0) {
      console.log(
        `\nNon-COMPLETED runs (${failedRuns.length} / ${runs.length}, ${(
          (failedRuns.length / runs.length) *
          100
        ).toFixed(1)}%)`,
      );
      for (const r of failedRuns.slice(0, 10)) {
        const missing = r.partialDimensions.length > 0
          ? `missing [${r.partialDimensions.join(', ')}]`
          : '';
        console.log(
          `  ${r.analysisId} ${r.status} ${r.symbol}@${r.market} ${missing}`,
        );
      }
      if (failedRuns.length > 10) {
        console.log(`  ... and ${failedRuns.length - 10} more`);
      }
    } else {
      console.log(`\nAll runs COMPLETED ✓`);
    }

    console.log();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
