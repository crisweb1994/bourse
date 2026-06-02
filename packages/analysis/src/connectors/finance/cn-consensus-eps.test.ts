/**
 * v0.8 C1 — CN finance connector `fetchConsensusEps` unit tests.
 *
 * Covers:
 *  - Eastmoney happy path: parsed forecasts + citation + freshness.
 *  - "No rows" (empty result.data) → data:null, no warning.
 *  - HTTP 429 → RATE_LIMITED warning + retryAfterMs.
 *  - Invalid instrumentId / non-CN market → typed warning, data:null.
 *  - JSON parse failure → PARTIAL_DATA warning.
 */
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../types';
import { createCnFinanceConnector } from './cn';

function eastmoneyConsensusFetch(
  payload: unknown,
  ok = true,
  status = 200,
): FetchLike {
  return async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
}

function rateLimitedFetch(): FetchLike {
  return async () => ({
    ok: false,
    status: 429,
    json: async () => ({}),
    text: async () => '',
  });
}

describe('cn finance connector — fetchConsensusEps', () => {
  it('parses eastmoney RPT_RES_PROFITPREDICT happy path', async () => {
    const c = createCnFinanceConnector();
    // Hotfix 2026-05-25: Eastmoney removed RPT_RES_CONFORECASTPREDATA endpoint
    // ("报表配置不存在"). Switched to RPT_RES_PROFITPREDICT which exposes
    // EPS / PE / PARENT_NETPROFIT / TOTAL_OPERATE_INCOME but no NUM_OF_ORG.
    const payload = {
      result: {
        data: [
          { PREDICT_YEAR: 2025, EPS: '70.12', PE: 22.4 },
          { PREDICT_YEAR: 2026, EPS: 78.5, PE: 20.0 },
          { PREDICT_YEAR: 2027, EPS: 85.4, PE: 18.4 },
        ],
      },
    };
    const out = await c.fetchConsensusEps!(
      { instrumentId: 'CN:600519' },
      { fetchLike: eastmoneyConsensusFetch(payload) },
    );
    expect(out.warnings).toHaveLength(0);
    expect(out.data).not.toBeNull();
    expect(out.data!.forecasts).toHaveLength(3);
    expect(out.data!.forecasts[0]).toEqual({ year: 2025, value: 70.12 });
    expect(out.data!.forecasts[2]).toEqual({ year: 2027, value: 85.4 });
    // headline (nearest forward year) == first row after asc sort
    expect(out.data!.avgEps).toBeCloseTo(70.12);
    // analystCount is no longer exposed by the new endpoint — defaults to 0.
    expect(out.data!.analystCount).toBe(0);
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0].provider).toBe('eastmoney');
    expect(out.citations[0].url).toContain('RPT_RES_PROFITPREDICT');
    expect(out.freshness[0].stale).toBe(false);
  });

  it('returns data:null without warning when result.data is empty (no analyst coverage)', async () => {
    const c = createCnFinanceConnector();
    const out = await c.fetchConsensusEps!(
      { instrumentId: 'CN:300999' },
      { fetchLike: eastmoneyConsensusFetch({ result: { data: [] } }) },
    );
    expect(out.data).toBeNull();
    expect(out.warnings).toHaveLength(0);
    expect(out.freshness[0].stale).toBe(true);
    expect(out.freshness[0].reason).toMatch(/no forecast rows/);
  });

  it('surfaces RATE_LIMITED with retryAfterMs on 429', async () => {
    const c = createCnFinanceConnector();
    const out = await c.fetchConsensusEps!(
      { instrumentId: 'CN:600519' },
      { fetchLike: rateLimitedFetch() },
    );
    expect(out.data).toBeNull();
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0].code).toBe('RATE_LIMITED');
    expect(out.warnings[0].retryAfterMs).toBe(30_000);
  });

  it('rejects invalid instrumentId', async () => {
    const c = createCnFinanceConnector();
    const out = await c.fetchConsensusEps!(
      { instrumentId: 'not-a-valid-id' },
      { fetchLike: eastmoneyConsensusFetch({ result: { data: [] } }) },
    );
    expect(out.warnings[0].code).toBe('INVALID_INSTRUMENT');
    expect(out.data).toBeNull();
  });

  it('rejects non-CN market', async () => {
    const c = createCnFinanceConnector();
    const out = await c.fetchConsensusEps!(
      { instrumentId: 'US:AAPL' },
      { fetchLike: eastmoneyConsensusFetch({ result: { data: [] } }) },
    );
    expect(out.warnings[0].code).toBe('UNSUPPORTED_MARKET');
    expect(out.data).toBeNull();
  });

  it('returns PARTIAL_DATA when payload is malformed', async () => {
    const c = createCnFinanceConnector();
    const out = await c.fetchConsensusEps!(
      { instrumentId: 'CN:600519' },
      // No `result.data` array — connector should report PARTIAL_DATA.
      { fetchLike: eastmoneyConsensusFetch({ noResult: true }) },
    );
    expect(out.data).toBeNull();
    expect(out.warnings[0].code).toBe('PARTIAL_DATA');
  });
});
