import { describe, expect, it } from 'vitest';
import { CN, HK, JP, UK, US } from '../../markets';

describe('markets/US', () => {
  it('validates AAPL / BRK.B / MSFT', () => {
    for (const s of ['AAPL', 'BRK.B', 'MSFT']) {
      expect(US.validateSymbol(s)).toBe(true);
    }
  });
  it('rejects HK/CN/JP formats', () => {
    expect(US.validateSymbol('0700.HK')).toBe(false);
    expect(US.validateSymbol('600519.SS')).toBe(false);
    expect(US.validateSymbol('7203.T')).toBe(false);
  });
  it('normalizeSymbol uppercases and trims', () => {
    expect(US.normalizeSymbol(' aapl ')).toBe('AAPL');
  });
  it('providerSymbols maps to bloomberg', () => {
    expect(US.providerSymbols('AAPL').bloomberg).toBe('AAPL US Equity');
  });
  it('displayCurrency = USD', () => {
    expect(US.displayCurrency).toBe('USD');
  });
});

describe('markets/HK', () => {
  it('validates 4-5 digit + .HK', () => {
    expect(HK.validateSymbol('0700.HK')).toBe(true);
    expect(HK.validateSymbol('00700.HK')).toBe(true);
    expect(HK.validateSymbol('700.HK')).toBe(false); // not yet padded
  });
  it('normalizeSymbol pads leading zeros to 4 digits', () => {
    expect(HK.normalizeSymbol('700')).toBe('0700.HK');
    expect(HK.normalizeSymbol('700.hk')).toBe('0700.HK');
    expect(HK.normalizeSymbol('00700.HK')).toBe('00700.HK');
  });
  it('providerSymbols strips leading zeros for bloomberg', () => {
    expect(HK.providerSymbols('0700.HK').bloomberg).toBe('700 HK Equity');
  });
});

describe('markets/CN', () => {
  it('validates Shanghai/Shenzhen/Beijing suffixes', () => {
    expect(CN.validateSymbol('600519.SS')).toBe(true);
    expect(CN.validateSymbol('000858.SZ')).toBe(true);
    expect(CN.validateSymbol('430510.BJ')).toBe(true);
  });
  it('infers SS for 60xxxx', () => {
    expect(CN.normalizeSymbol('600519')).toBe('600519.SS');
  });
  it('infers SZ for 00xxxx and 30xxxx', () => {
    expect(CN.normalizeSymbol('000858')).toBe('000858.SZ');
    expect(CN.normalizeSymbol('300750')).toBe('300750.SZ');
  });
  it('infers BJ for 8xxxxx', () => {
    expect(CN.normalizeSymbol('830879')).toBe('830879.BJ');
  });

  // RFC-02 §7 — A-share routing config is embedded on the CN profile.
  it('exposes domainTiers with cninfo as Tier A', () => {
    expect(CN.domainTiers).toBeDefined();
    expect(CN.domainTiers!['cninfo.com.cn']).toBe('A');
    expect(CN.domainTiers!['sse.com.cn']).toBe('A');
    expect(CN.domainTiers!['csrc.gov.cn']).toBe('A');
  });
  it('classifies eastmoney as Tier B (not A)', () => {
    expect(CN.domainTiers!['eastmoney.com']).toBe('B');
  });
  it('classifies xueqiu / tonghuashun as Tier D', () => {
    expect(CN.domainTiers!['xueqiu.com']).toBe('D');
    expect(CN.domainTiers!['10jqka.com.cn']).toBe('D');
  });
  it('exposes endpoints with eastmoney + tencent + cninfo bases', () => {
    expect(CN.endpoints).toBeDefined();
    expect(CN.endpoints!.eastmoney.base).toMatch(/^https?:\/\//);
    expect(CN.endpoints!.tencent.base).toMatch(/^https?:\/\//);
    expect(CN.endpoints!.cninfo.base).toMatch(/^https?:\/\//);
  });
  it('exposes sourcePriorities with tencent first for quote', () => {
    expect(CN.sourcePriorities).toBeDefined();
    expect(CN.sourcePriorities!.quote[0]).toBe('tencent');
    expect(CN.sourcePriorities!.quote).toContain('eastmoney');
  });
  it('exposes sourcePriorities with cninfo first for filings', () => {
    expect(CN.sourcePriorities!.latestFilingUrls[0]).toBe('cninfo');
  });
  it('exposes sourcePriorities for all A-share specific facts', () => {
    expect(CN.sourcePriorities!.consensusEps).toBeDefined();
    expect(CN.sourcePriorities!.lhbAppearances).toBeDefined();
    expect(CN.sourcePriorities!.northboundFlow).toBeDefined();
    expect(CN.sourcePriorities!.unlockCalendar).toBeDefined();
    expect(CN.sourcePriorities!.shareholderConcentration).toBeDefined();
  });
});

// RFC-02: other markets (US/HK/JP/UK) do not yet have v2 routing config.
// These tests pin that gap so a future RFC consciously populates them.
describe('markets/non-CN v2 routing gap', () => {
  it('US/HK/JP/UK have undefined domainTiers (Phase 1 scope)', async () => {
    const { US, HK, JP, UK } = await import('../../markets');
    expect(US.domainTiers).toBeUndefined();
    expect(HK.domainTiers).toBeUndefined();
    expect(JP.domainTiers).toBeUndefined();
    expect(UK.domainTiers).toBeUndefined();
  });
  it('US/HK/JP/UK have undefined sourcePriorities (Phase 1 scope)', async () => {
    const { US, HK, JP, UK } = await import('../../markets');
    expect(US.sourcePriorities).toBeUndefined();
    expect(HK.sourcePriorities).toBeUndefined();
    expect(JP.sourcePriorities).toBeUndefined();
    expect(UK.sourcePriorities).toBeUndefined();
  });
});

describe('markets/JP', () => {
  it('validates 4 digits + .T', () => {
    expect(JP.validateSymbol('7203.T')).toBe(true);
    expect(JP.validateSymbol('72030.T')).toBe(false);
  });
  it('normalize adds .T suffix', () => {
    expect(JP.normalizeSymbol('7203')).toBe('7203.T');
  });
  it('bloomberg uses JP suffix', () => {
    expect(JP.providerSymbols('7203.T').bloomberg).toBe('7203 JP Equity');
  });
});

describe('markets/UK', () => {
  it('validates ALPHANUM + .L', () => {
    expect(UK.validateSymbol('BARC.L')).toBe(true);
    expect(UK.validateSymbol('III.L')).toBe(true);
  });
  it('normalize adds .L suffix when missing', () => {
    expect(UK.normalizeSymbol('barc')).toBe('BARC.L');
  });
  it('bloomberg uses LN suffix', () => {
    expect(UK.providerSymbols('BARC.L').bloomberg).toBe('BARC LN Equity');
  });
});
