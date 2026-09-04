import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localParts } from './market-hours';

/** KISS C6-9: only localParts remains here (session state moved to
 *  market-data's rule-based calendar); keep DST correctness pinned. */

describe('localParts · exchange-timezone calendar parts', () => {
  it('computes weekday/minutes/ymd in the exchange timezone (EDT vs Shanghai)', () => {
    // 2026-07-20T04:30Z → New York 00:30 Monday; Shanghai 12:30 Monday.
    const at = new Date('2026-07-20T04:30:00.000Z');
    const ny = localParts('America/New_York', at);
    const sh = localParts('Asia/Shanghai', at);
    assert.equal(ny.weekday, 1);
    assert.equal(ny.minutes, 30);
    assert.equal(ny.ymd, '2026-07-20');
    assert.equal(sh.weekday, 1);
    assert.equal(sh.minutes, 12 * 60 + 30);
  });

  it('is DST-correct: the same wall clock maps to different UTC instants across DST', () => {
    // America/New_York: 2026-01-15 12:00 EST = 17:00Z; 2026-07-15 12:00 EDT = 16:00Z.
    const winter = localParts('America/New_York', new Date('2026-01-15T17:00:00.000Z'));
    const summer = localParts('America/New_York', new Date('2026-07-15T16:00:00.000Z'));
    assert.equal(winter.minutes, 12 * 60);
    assert.equal(summer.minutes, 12 * 60);
  });
});
