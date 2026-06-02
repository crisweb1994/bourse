import { describe, expect, it } from 'vitest';
import type { StructuredJson } from '../../contracts/analysis-result';
import {
  computeDeviation,
  extractFact,
  type ExtractInput,
} from '../../primitives/cross-dim-extract';

const BASE_JSON: StructuredJson = {
  schemaVersion: 'agent-result-v1',
  conclusion: {
    signal: 'NEUTRAL',
    confidence: 'MEDIUM',
    oneLiner: 'baseline',
    evidence: [],
  },
  evidence: [],
  dataAvailability: { missingFields: [], reason: 'ok' },
  dataAsOf: '2026-05-13',
  disclaimer: 'd',
};

function input(
  overrides: Partial<ExtractInput> = {},
): ExtractInput {
  return {
    type: 'FUNDAMENTAL',
    reportMarkdown: '',
    structuredJson: BASE_JSON,
    ...overrides,
  };
}

// ===== computeDeviation =====

describe('primitives/computeDeviation', () => {
  it('returns 0 for equal numbers', () => {
    expect(computeDeviation(100, 100)).toBe(0);
  });

  it('returns percent for finite mismatch', () => {
    expect(computeDeviation(105, 100)).toBe(5);
    expect(computeDeviation(95, 100)).toBe(5);
  });

  it('returns +Infinity when ground truth is 0 and observed non-zero', () => {
    expect(computeDeviation(1, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns 0 when both are 0', () => {
    expect(computeDeviation(0, 0)).toBe(0);
  });

  it('returns null when either side is non-number', () => {
    expect(computeDeviation('USD', 'USD')).toBeNull();
    expect(computeDeviation(100, 'x')).toBeNull();
    expect(computeDeviation(null, 100)).toBeNull();
  });

  it('returns null for NaN / Infinity inputs', () => {
    expect(computeDeviation(Number.NaN, 100)).toBeNull();
    expect(computeDeviation(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ===== price =====

describe('primitives/extractFact — price', () => {
  it('prefers structuredJson.priceTarget.base when present', () => {
    const obs = extractFact(
      input({
        structuredJson: {
          ...BASE_JSON,
          priceTarget: { base: 18.5, currency: 'CNY', horizonDays: 90 },
        },
      }),
      'price',
    );
    expect(obs?.value).toBe(18.5);
    expect(obs?.extractedFrom).toBe('structuredJson.priceTarget.base');
  });

  it('falls back to markdown regex (中文)', () => {
    const obs = extractFact(
      input({ reportMarkdown: '公司当前价: 18.20 元' }),
      'price',
    );
    expect(obs?.value).toBe(18.2);
    expect(obs?.extractedFrom).toBe('reportMarkdown:regex:price');
  });

  it('falls back to markdown regex (english "price = 18.20")', () => {
    const obs = extractFact(
      input({ reportMarkdown: 'spot price = 18.20' }),
      'price',
    );
    expect(obs?.value).toBe(18.2);
  });

  it('returns null when neither structured nor markdown has a value', () => {
    expect(extractFact(input(), 'price')).toBeNull();
  });
});

// ===== marketCap =====

describe('primitives/extractFact — marketCap', () => {
  it('extracts 亿 unit (Chinese standard)', () => {
    const obs = extractFact(
      input({ reportMarkdown: '总市值约 22875.6 亿元' }),
      'marketCap',
    );
    expect(obs?.value).toBe(22875.6);
    expect(obs?.extractedFrom).toBe('reportMarkdown:regex:marketCap');
  });

  it('normalizes 万亿 → 亿 (× 10000)', () => {
    const obs = extractFact(
      input({ reportMarkdown: '总市值 2.3 万亿' }),
      'marketCap',
    );
    expect(obs?.value).toBe(23000);
  });

  it('normalizes 万 → 亿 (÷ 10000)', () => {
    const obs = extractFact(
      input({ reportMarkdown: '流通市值 50000 万' }),
      'marketCap',
    );
    expect(obs?.value).toBeCloseTo(5, 6);
  });

  it('strips thousand-separators', () => {
    const obs = extractFact(
      input({ reportMarkdown: '总市值: 1,234.5 亿' }),
      'marketCap',
    );
    expect(obs?.value).toBe(1234.5);
  });

  it('normalizes English "B" (billion) → 亿 (× 10)', () => {
    const obs = extractFact(
      input({ reportMarkdown: 'market cap: 3.0 B' }),
      'marketCap',
    );
    expect(obs?.value).toBeCloseTo(30, 6);
  });

  it('returns null when no marketCap pattern matches', () => {
    expect(
      extractFact(input({ reportMarkdown: '基本面良好' }), 'marketCap'),
    ).toBeNull();
  });
});

// ===== currency =====

describe('primitives/extractFact — currency', () => {
  it('reads from structuredJson.priceTarget.currency', () => {
    const obs = extractFact(
      input({
        structuredJson: {
          ...BASE_JSON,
          priceTarget: { base: 100, currency: 'CNY', horizonDays: 30 },
        },
      }),
      'currency',
    );
    expect(obs?.value).toBe('CNY');
    expect(obs?.extractedFrom).toBe('structuredJson.priceTarget.currency');
  });

  it('uppercases lowercase currency codes', () => {
    const obs = extractFact(
      input({
        structuredJson: {
          ...BASE_JSON,
          priceTarget: { base: 100, currency: 'cny', horizonDays: 30 },
        },
      }),
      'currency',
    );
    expect(obs?.value).toBe('CNY');
  });

  it('returns null when priceTarget absent', () => {
    expect(extractFact(input(), 'currency')).toBeNull();
  });
});

// ===== pe =====

describe('primitives/extractFact — pe', () => {
  it('extracts "PE: 28.7"', () => {
    const obs = extractFact(
      input({ reportMarkdown: '当前 PE: 28.7' }),
      'pe',
    );
    expect(obs?.value).toBe(28.7);
  });

  it('extracts "PE (TTM): 28.7"', () => {
    const obs = extractFact(
      input({ reportMarkdown: 'PE (TTM): 28.7 倍' }),
      'pe',
    );
    expect(obs?.value).toBe(28.7);
  });

  it('extracts "PE（动态）= 28.7"', () => {
    const obs = extractFact(
      input({ reportMarkdown: 'PE（动态）= 28.7' }),
      'pe',
    );
    expect(obs?.value).toBe(28.7);
  });

  it('extracts "市盈率：28.7"', () => {
    const obs = extractFact(
      input({ reportMarkdown: '市盈率：28.7' }),
      'pe',
    );
    expect(obs?.value).toBe(28.7);
  });

  it('extracts "市盈率(TTM) 为 28.7 倍"', () => {
    const obs = extractFact(
      input({ reportMarkdown: '市盈率(TTM) 为 28.7 倍' }),
      'pe',
    );
    expect(obs?.value).toBe(28.7);
  });

  it('returns null when no PE pattern matches', () => {
    expect(
      extractFact(input({ reportMarkdown: 'no PE here' }), 'pe'),
    ).toBeNull();
  });
});

// ===== dataAsOf =====

describe('primitives/extractFact — dataAsOf', () => {
  it('reads from structuredJson.dataAsOf (baseline field)', () => {
    const obs = extractFact(input(), 'dataAsOf');
    expect(obs?.value).toBe('2026-05-13');
    expect(obs?.extractedFrom).toBe('structuredJson.dataAsOf');
  });

  it('returns null when dataAsOf is malformed', () => {
    const obs = extractFact(
      input({
        structuredJson: { ...BASE_JSON, dataAsOf: 'not-a-date' as any },
      }),
      'dataAsOf',
    );
    expect(obs).toBeNull();
  });
});

// ===== sectionType propagation =====

describe('primitives/extractFact — sectionType propagation', () => {
  it('carries the source dim type into the observation', () => {
    const obs = extractFact(
      input({
        type: 'VALUATION',
        reportMarkdown: 'PE: 30.5',
      }),
      'pe',
    );
    expect(obs?.sectionType).toBe('VALUATION');
  });
});
