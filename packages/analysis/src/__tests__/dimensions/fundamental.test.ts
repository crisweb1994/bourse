import { describe, expect, it } from 'vitest';
import { StructuredJson } from '../../contracts/analysis-result';
import { getDimension } from '../../dimensions';
const FUNDAMENTAL = getDimension('FUNDAMENTAL');

describe('dimensions/FUNDAMENTAL', () => {
  it('declares the FUNDAMENTAL type', () => {
    expect(FUNDAMENTAL.type).toBe('FUNDAMENTAL');
  });

  it('only allows webSearch', () => {
    expect(FUNDAMENTAL.allowedTools).toEqual(['webSearch']);
  });

  it('outputSchema is StructuredJson (baseline contract)', () => {
    expect(FUNDAMENTAL.outputSchema).toBe(StructuredJson);
  });

  it('onFailure is retry-once', () => {
    expect(FUNDAMENTAL.onFailure).toBe('retry-once');
  });

  describe('buildPrompts', () => {
    const ctx = { todayDate: '2026-05-10' };

    it('system prompt mentions the three required analysis sections', () => {
      const { system } = FUNDAMENTAL.buildPrompts(
        { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
        ctx,
      );
      expect(system).toContain('商业模式');
      expect(system).toContain('财务趋势');
      expect(system).toContain('盈利质量');
      expect(system).toContain('护城河');
    });

    it('user prompt uses display name when provided', () => {
      const { user } = FUNDAMENTAL.buildPrompts(
        { symbol: 'AAPL', market: 'US', name: '苹果公司', locale: 'zh-CN' },
        ctx,
      );
      expect(user).toContain('苹果公司（AAPL，US 市场）');
    });

    it('user prompt falls back to symbol when name omitted', () => {
      const { user } = FUNDAMENTAL.buildPrompts(
        { symbol: 'AAPL', market: 'US', locale: 'zh-CN' },
        ctx,
      );
      expect(user).toContain('AAPL（AAPL，US 市场）');
    });
  });

  describe('inputSchema', () => {
    it('rejects empty symbol', () => {
      expect(() =>
        FUNDAMENTAL.inputSchema.parse({
          symbol: '',
          market: 'US',
          locale: 'zh-CN',
        }),
      ).toThrow();
    });

    it('rejects locale shorter than 2 chars', () => {
      expect(() =>
        FUNDAMENTAL.inputSchema.parse({
          symbol: 'AAPL',
          market: 'US',
          locale: 'z',
        }),
      ).toThrow();
    });

    it('accepts minimal valid input', () => {
      expect(
        FUNDAMENTAL.inputSchema.parse({
          symbol: 'AAPL',
          market: 'US',
          locale: 'zh-CN',
        }),
      ).toMatchObject({ symbol: 'AAPL' });
    });
  });

  describe('score', () => {
    function fakeResult(signal: 'BULLISH' | 'NEUTRAL' | 'BEARISH', conf: 'HIGH' | 'MEDIUM' | 'LOW') {
      return {
        schemaVersion: 'agent-result-v1' as const,
        conclusion: { signal, confidence: conf, oneLiner: 'x', evidence: [] },
        evidence: [],
        dataAvailability: { missingFields: [], reason: '' },
        dataAsOf: '2026-05-10',
        disclaimer: 'd',
      };
    }

    it('uses defaultScore lookup', () => {
      expect(FUNDAMENTAL.score(fakeResult('BULLISH', 'HIGH'))).toBe(85);
      expect(FUNDAMENTAL.score(fakeResult('NEUTRAL', 'MEDIUM'))).toBe(50);
      expect(FUNDAMENTAL.score(fakeResult('BEARISH', 'HIGH'))).toBe(15);
    });
  });
});
