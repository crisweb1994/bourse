import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDigestWindow } from './digest-windows';

// ============================================================================
// 窗口判断单测。用固定 Date（UTC）模拟各市场交易所时区的窗口时刻，验证命中/未命中。
// 时区换算（关键）：
//   US  America/New_York  PRE 08:30-09:25 ET / POST 16:05-16:30 ET
//   CN  Asia/Shanghai     PRE 09:00-09:25    / POST 15:05-15:30
//   HK  Asia/Hong_Kong    PRE 09:00-09:25    / POST 16:05-16:30
// ============================================================================

// 构造一个「市场当地某日某时分」对应的 UTC 时刻。
// tzOffsetMinutes: 该市场相对 UTC 的偏移（夏令时变动这里按固定值，单测只验窗口逻辑）。
function atLocal(tzOffsetMinutes: number, weekday: number, h: number, m: number): Date {
  // 取一个已知是「该 weekday」的基准日（2026-07-06 是周一）。
  const monday = new Date(Date.UTC(2026, 6, 6)); // 2026-07-06 Mon 00:00 UTC
  const dayOffset = weekday - 1; // 1=Mon基准
  const localMs = (dayOffset * 24 + h) * 60 + m; // 当地当日零点起的分钟数
  const utcMs = monday.getTime() + (localMs - tzOffsetMinutes) * 60_000;
  return new Date(utcMs);
}

describe('resolveDigestWindow · US（America/New_York，按 -4h 夏令时算）', () => {
  // US 夏令时 UTC-4
  const TZ = -4 * 60;

  it('PRE 窗口内（08:30 ET）→ 命中 PRE', () => {
    const hit = resolveDigestWindow('US', atLocal(TZ, 1, 8, 30));
    assert.deepEqual(hit && { market: hit.market, session: hit.session }, {
      market: 'US',
      session: 'PRE',
    });
  });

  it('PRE 窗口边界 09:25 → 命中；09:26 → 不命中', () => {
    assert.equal(resolveDigestWindow('US', atLocal(TZ, 1, 9, 25))?.session, 'PRE');
    assert.equal(resolveDigestWindow('US', atLocal(TZ, 1, 9, 26)), null);
  });

  it('POST 窗口内（16:10 ET）→ 命中 POST', () => {
    assert.equal(resolveDigestWindow('US', atLocal(TZ, 1, 16, 10))?.session, 'POST');
  });

  it('POST 窗口边界 16:30 → 不命中（右开）', () => {
    assert.equal(resolveDigestWindow('US', atLocal(TZ, 1, 16, 30)), null);
  });

  it('盘中 12:00 → 不命中（不在投递窗口）', () => {
    assert.equal(resolveDigestWindow('US', atLocal(TZ, 1, 12, 0)), null);
  });

  it('周末（周六 08:30 ET）→ 不命中', () => {
    assert.equal(resolveDigestWindow('US', atLocal(TZ, 6, 8, 30)), null);
  });
});

describe('resolveDigestWindow · CN（Asia/Shanghai，UTC+8）', () => {
  const TZ = 8 * 60;

  it('PRE 09:00 → 命中 PRE', () => {
    assert.equal(resolveDigestWindow('CN', atLocal(TZ, 1, 9, 0))?.session, 'PRE');
  });

  it('POST 15:05 → 命中 POST', () => {
    assert.equal(resolveDigestWindow('CN', atLocal(TZ, 1, 15, 5))?.session, 'POST');
  });

  it('POST 边界 15:30 → 不命中', () => {
    assert.equal(resolveDigestWindow('CN', atLocal(TZ, 1, 15, 30)), null);
  });

  it('周末（周日 09:00）→ 不命中', () => {
    assert.equal(resolveDigestWindow('CN', atLocal(TZ, 0, 9, 0)), null);
  });
});

describe('resolveDigestWindow · HK（Asia/Hong_Kong，UTC+8）', () => {
  const TZ = 8 * 60;

  it('PRE 09:00 → 命中 PRE', () => {
    assert.equal(resolveDigestWindow('HK', atLocal(TZ, 1, 9, 0))?.session, 'PRE');
  });

  it('POST 16:05 → 命中 POST', () => {
    assert.equal(resolveDigestWindow('HK', atLocal(TZ, 1, 16, 5))?.session, 'POST');
  });
});

describe('resolveDigestWindow · localYmd（幂等键组成部分）', () => {
  it('返回当地交易所时区 ymd（不是 UTC）', () => {
    const TZ = 8 * 60; // CN
    const hit = resolveDigestWindow('CN', atLocal(TZ, 1, 9, 0));
    assert.equal(hit?.localYmd, '2026-07-06'); // 当地周一
  });
});
