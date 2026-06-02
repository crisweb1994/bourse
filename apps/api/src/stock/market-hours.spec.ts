import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarketState } from './market-hours';

// Helper: build a UTC instant. The resolver converts to the exchange tz
// internally, so we assert via known UTC↔exchange offsets.
const utc = (iso: string): Date => new Date(iso);

test('US: regular session (EDT) → REGULAR', () => {
  // 2026-06-01 是周一。14:00 UTC = 10:00 EDT（盘中）。
  assert.equal(resolveMarketState('US', utc('2026-06-01T14:00:00Z')), 'REGULAR');
});

test('US: pre-market and after-hours', () => {
  // 12:00 UTC = 08:00 EDT → 盘前
  assert.equal(resolveMarketState('US', utc('2026-06-01T12:00:00Z')), 'PRE');
  // 21:00 UTC = 17:00 EDT → 盘后
  assert.equal(resolveMarketState('US', utc('2026-06-01T21:00:00Z')), 'POST');
});

test('US: weekend → CLOSED regardless of clock', () => {
  // 2026-05-30 周六，14:00 UTC 即便在"时段内"也应收盘
  assert.equal(resolveMarketState('US', utc('2026-05-30T14:00:00Z')), 'CLOSED');
});

test('US: timezone of caller is irrelevant (same instant, same result)', () => {
  const at = utc('2026-06-01T14:00:00Z');
  // 不管进程 TZ 如何，结果取决于交易所时区
  assert.equal(resolveMarketState('US', at), 'REGULAR');
});

test('US: holiday guard — last trade from a prior date downgrades to CLOSED', () => {
  // 时钟在盘中，但最后成交时间是上一交易日 → 当日未开市（节假日）
  const at = utc('2026-06-01T14:00:00Z'); // Mon 10:00 EDT
  const lastTrade = utc('2026-05-29T20:00:00Z'); // 前一交易日收盘
  assert.equal(resolveMarketState('US', at, lastTrade.toISOString()), 'CLOSED');
  // 最后成交就在当天 → 仍 REGULAR
  const sameDay = utc('2026-06-01T13:55:00Z');
  assert.equal(resolveMarketState('US', at, sameDay.toISOString()), 'REGULAR');
});

test('CN: morning session, lunch break, afternoon', () => {
  // 周一。01:30 UTC = 09:30 CST → 开盘
  assert.equal(resolveMarketState('CN', utc('2026-06-01T01:30:00Z')), 'REGULAR');
  // 04:00 UTC = 12:00 CST → 午间休市 → CLOSED
  assert.equal(resolveMarketState('CN', utc('2026-06-01T04:00:00Z')), 'CLOSED');
  // 05:30 UTC = 13:30 CST → 下午盘
  assert.equal(resolveMarketState('CN', utc('2026-06-01T05:30:00Z')), 'REGULAR');
  // 07:30 UTC = 15:30 CST → 收盘
  assert.equal(resolveMarketState('CN', utc('2026-06-01T07:30:00Z')), 'CLOSED');
});

test('HK: lunch break differs from CN (12:00–13:00)', () => {
  // 周一。03:30 UTC = 11:30 HKT → HK 仍开盘（CN 已休市）
  assert.equal(resolveMarketState('HK', utc('2026-06-01T03:30:00Z')), 'REGULAR');
  // 04:30 UTC = 12:30 HKT → HK 午休 → CLOSED
  assert.equal(resolveMarketState('HK', utc('2026-06-01T04:30:00Z')), 'CLOSED');
});

test('unknown market → CLOSED', () => {
  assert.equal(resolveMarketState('JP', utc('2026-06-01T02:00:00Z')), 'CLOSED');
  assert.equal(resolveMarketState('', utc('2026-06-01T02:00:00Z')), 'CLOSED');
});
