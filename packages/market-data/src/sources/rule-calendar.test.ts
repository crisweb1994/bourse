import { describe, expect, it } from 'vitest';
import { createRuleBasedMarketCalendarPort } from './rule-calendar';

describe('rule-based market calendar', () => {
  const port = createRuleBasedMarketCalendarPort();
  const context = {
    timeoutMs: 1_000,
    credentialScope: 'public' as const,
    traceId: 'test',
    now: () => new Date('2026-07-25T12:00:00.000Z'),
  };

  it('marks a weekend as closed without treating the quote as stale', async () => {
    const result = await port.getMarketSession({ market: 'HK', at: '2026-07-25T12:00:00.000Z' }, context);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected market session');
    expect(result.data.state).toBe('HOLIDAY');
    expect(result.data.timezone).toBe('Asia/Hong_Kong');
  });

  it('identifies the US regular trading session in exchange time', async () => {
    const result = await port.getMarketSession({ market: 'US', at: '2026-07-24T15:00:00.000Z' }, context);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected market session');
    expect(result.data.state).toBe('OPEN');
  });
});
