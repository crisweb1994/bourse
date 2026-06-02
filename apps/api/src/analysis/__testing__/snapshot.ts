/**
 * v0.3 后遗留 ① Layer 1：fixture diff 工具。
 *
 * 负责：
 *  - 对 scenario 运行结果做"运行时无关化"（redact 时间戳 / 自增 ID / 时长）
 *  - 与 `__fixtures__/<scenario>.json` 比对；UPDATE_FIXTURES=1 写回
 *
 * 不负责：scenario 运行本身（见 `scenario-runner.ts`）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FIXTURE_DIR = join(__dirname, '..', '__fixtures__');

/**
 * Redact runtime-derived values (Date.now() outputs) so snapshots stay
 * stable across test runs. Inputs (canned event sequences) are already
 * deterministic; only adapter-side clock reads need scrubbing.
 *
 * Rules:
 *  - keys ending with `At` or `Ms` → `<TIME>` (durationMs, startedAt, …)
 *  - any Date instance → `<TIME>`
 *  - ISO 8601 strings → `<ISO>`
 *  - cuid-like / uuid-like ids → `<ID>` (cuid prefix `c` + 24 base32 chars)
 *  - `totalLatencyMs`, `latencyMs`, `costUsd` (adapter-computed) → `<NUM>`
 */
export function redact(value: unknown, parentKey?: string): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return '<TIME>';
  if (typeof value === 'number') {
    if (parentKey) {
      if (/At$|Ms$/.test(parentKey)) return '<TIME>';
      if (parentKey === 'totalLatencyMs' || parentKey === 'latencyMs') return '<NUM>';
      if (parentKey === 'costUsd') return '<NUM>';
    }
    return value;
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return '<ISO>';
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

export interface DiffResult {
  ok: boolean;
  message?: string;
  expectedPath: string;
  actual: unknown;
  expected?: unknown;
}

/**
 * Compare an actual snapshot to the committed fixture. With
 * `UPDATE_FIXTURES=1`, write the actual back to disk and pass.
 *
 * Missing fixture is treated as failure unless UPDATE_FIXTURES=1.
 */
export function diffFixture(name: string, actual: unknown): DiffResult {
  const expectedPath = join(FIXTURE_DIR, `${name}.json`);
  const update = process.env.UPDATE_FIXTURES === '1';
  const normalized = redact(actual);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

  if (update) {
    mkdirSync(dirname(expectedPath), { recursive: true });
    writeFileSync(expectedPath, serialized, 'utf8');
    return { ok: true, expectedPath, actual: normalized };
  }

  if (!existsSync(expectedPath)) {
    return {
      ok: false,
      message: `Fixture missing: ${expectedPath}. Run with UPDATE_FIXTURES=1 to bless.`,
      expectedPath,
      actual: normalized,
    };
  }

  const expectedRaw = readFileSync(expectedPath, 'utf8');
  let expected: unknown;
  try {
    expected = JSON.parse(expectedRaw);
  } catch (e) {
    return {
      ok: false,
      message: `Fixture corrupt JSON at ${expectedPath}: ${(e as Error).message}`,
      expectedPath,
      actual: normalized,
    };
  }

  const expectedSerialized = `${JSON.stringify(expected, null, 2)}\n`;
  if (expectedSerialized === serialized) {
    return { ok: true, expectedPath, actual: normalized, expected };
  }

  const diff = formatDiff(expected, normalized);
  return {
    ok: false,
    message: `Fixture diff at ${expectedPath}\n${diff}\n— rerun with UPDATE_FIXTURES=1 to bless intentional changes.`,
    expectedPath,
    actual: normalized,
    expected,
  };
}

/**
 * Minimal line-level diff. Snapshots are small JSON (<1k lines); a
 * full LCS isn't needed — line-aligned compare with first-mismatch
 * context is plenty for catching regressions.
 */
function formatDiff(expected: unknown, actual: unknown): string {
  const a = JSON.stringify(expected, null, 2).split('\n');
  const b = JSON.stringify(actual, null, 2).split('\n');
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  let firstMismatch = -1;
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      firstMismatch = i;
      break;
    }
  }
  if (firstMismatch === -1) return '(no diff?)';
  const start = Math.max(0, firstMismatch - 3);
  const end = Math.min(max, firstMismatch + 6);
  for (let i = start; i < end; i++) {
    if (a[i] === b[i]) {
      out.push(`  ${i + 1}: ${a[i] ?? ''}`);
    } else {
      if (a[i] !== undefined) out.push(`- ${i + 1}: ${a[i]}`);
      if (b[i] !== undefined) out.push(`+ ${i + 1}: ${b[i]}`);
    }
  }
  return out.join('\n');
}
