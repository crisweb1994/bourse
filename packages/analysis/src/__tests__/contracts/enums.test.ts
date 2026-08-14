import { describe, expect, it } from 'vitest';
import {
  AnalysisMode,
  AnalysisStatus,
  Confidence,
  FocusWindow,
  OverallSignal,
  SectionStatus,
  SectionType,
} from '../../contracts/enums';

describe('Analysis V2 enums', () => {
  it('contains exactly the fixed modes, windows and sections', () => {
    expect(AnalysisMode.options).toEqual(['QUICK', 'DEEP']);
    expect(FocusWindow.options).toEqual(['30D', '90D', '1Y', '3Y']);
    expect(SectionType.options).toEqual([
      'COMPANY_QUALITY',
      'INDUSTRY_POSITION',
      'VALUATION_SCENARIOS',
      'RISK_REGISTER',
      'MARKET_SIGNALS',
    ]);
  });

  it('has no budget-exhausted or legacy dimension status', () => {
    expect(AnalysisStatus.safeParse('BUDGET_EXHAUSTED').success).toBe(false);
    for (const status of ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED']) {
      expect(SectionStatus.safeParse(status).success).toBe(true);
    }
    expect(OverallSignal.safeParse('POSITIVE').success).toBe(true);
    expect(OverallSignal.safeParse('BULLISH').success).toBe(false);
    expect(Confidence.parse('LOW')).toBe('LOW');
  });
});
