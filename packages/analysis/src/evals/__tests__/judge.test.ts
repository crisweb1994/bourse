/**
 * plan-v2 Wave 0 — judge unit tests + fixture regression.
 *
 * Tests load real fixture JSON files from src/evals/fixtures/ and run
 * the judge against locked expected/ files. Acts as the regression net
 * for the compute layer.
 *
 * When intentionally changing compute behavior, regenerate expected
 * files via:
 *   pnpm -F @bourse/analysis lock:fixtures
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hashRawFixture,
  judgeFixture,
  lockExpected,
  replayCompute,
} from '../judge';
import type { ExpectedFixture, RawFixture } from '../types';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');
const EXPECTED_DIR = join(__dirname, '..', 'expected');

function listFixtures(): RawFixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf-8')) as RawFixture);
}

function loadExpected(id: string): ExpectedFixture | null {
  const p = join(EXPECTED_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8')) as ExpectedFixture;
}

// ============================================================================
// hashRawFixture
// ============================================================================

describe('judge · hashRawFixture', () => {
  it('produces the same hash regardless of meta.vendoredAt', () => {
    const fix: RawFixture = {
      meta: {
        id: 't',
        symbol: 'X',
        market: 'US',
        vendoredAt: '2025-01-01T00:00:00.000Z',
        description: 'test',
      },
      rawFacts: { quote: { price: 100 } },
      citations: [],
      dataAvailability: { available: [], missing: [], warnings: [] },
    };
    const h1 = hashRawFixture(fix);
    const h2 = hashRawFixture({
      ...fix,
      meta: { ...fix.meta, vendoredAt: '2099-12-31T00:00:00.000Z' },
    });
    expect(h1).toBe(h2);
  });

  it('produces different hashes when rawFacts differ', () => {
    const base: RawFixture = {
      meta: { id: 't', symbol: 'X', market: 'US', vendoredAt: '', description: '' },
      rawFacts: { quote: { price: 100 } },
      citations: [],
      dataAvailability: { available: [], missing: [], warnings: [] },
    };
    const h1 = hashRawFixture(base);
    const h2 = hashRawFixture({ ...base, rawFacts: { quote: { price: 101 } } });
    expect(h1).not.toBe(h2);
  });

  it('is stable under key reordering', () => {
    const a: RawFixture = {
      meta: { id: 't', symbol: 'X', market: 'US', vendoredAt: '', description: '' },
      rawFacts: { quote: { price: 100, currency: 'USD' } },
      citations: [],
      dataAvailability: { available: [], missing: [], warnings: [] },
    };
    const b: RawFixture = {
      meta: { id: 't', symbol: 'X', market: 'US', vendoredAt: '', description: '' },
      rawFacts: { quote: { currency: 'USD', price: 100 } },
      citations: [],
      dataAvailability: { available: [], missing: [], warnings: [] },
    };
    expect(hashRawFixture(a)).toBe(hashRawFixture(b));
  });
});

// ============================================================================
// replayCompute
// ============================================================================

describe('judge · replayCompute', () => {
  const fixtures = listFixtures();

  for (const fix of fixtures) {
    it(`runs cleanly against fixture ${fix.meta.id}`, () => {
      const out = replayCompute(fix);
      // Smoke check: result shape always populated
      expect(out).toHaveProperty('availability');
      expect(out).toHaveProperty('redFlagsCount');
      expect(out.availability.available).toEqual([...fix.dataAvailability.available].sort());
    });
  }

  it('produces sane CN ratios after 万元/亿元 normalization (Maotai synthetic)', () => {
    const maotai = fixtures.find((f) => f.meta.id === 'SYN_600519_20250525');
    expect(maotai).toBeDefined();
    const out = replayCompute(maotai!);
    // 茅台 PE should land in 20-30 range, NOT 10000x off (unit bug regression)
    expect(out.ratios?.pe).toBeGreaterThan(20);
    expect(out.ratios?.pe).toBeLessThan(30);
    // Net margin ~ 49% (茅台 baseline)
    expect(out.ratios?.netMargin).toBeGreaterThan(0.48);
    expect(out.ratios?.netMargin).toBeLessThan(0.5);
  });
});

// ============================================================================
// Fixture regression — judge against locked expected files
// ============================================================================

describe('judge · fixture regression', () => {
  const fixtures = listFixtures();

  // Auto-lock when expected/ is missing. This bootstraps the regression net
  // the first time a fixture lands; subsequent compute changes that drift
  // outside tolerance will fail until a human re-locks (intentional
  // friction — re-locking should be a deliberate decision).
  for (const fix of fixtures) {
    const id = fix.meta.id;
    const expectedPath = join(EXPECTED_DIR, `${id}.json`);
    let expected = loadExpected(id);
    if (!expected) {
      mkdirSync(EXPECTED_DIR, { recursive: true });
      expected = lockExpected(fix);
      writeFileSync(expectedPath, JSON.stringify(expected, null, 2));
      // eslint-disable-next-line no-console
      console.log(`[judge] bootstrapped expected/${id}.json — review before commit`);
    }

    it(`${id} matches locked expected (diff tolerance ${0.5}%)`, () => {
      const result = judgeFixture(fix, expected!);
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `[judge] fixture ${id} diffs:\n${result.diffs
            .map((d) => `  ${d.path}: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}${d.note ? ' (' + d.note + ')' : ''}`)
            .join('\n')}`,
        );
      }
      expect(result.ok).toBe(true);
    });
  }
});
