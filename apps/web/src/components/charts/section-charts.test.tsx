import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ChartEvidenceResponse } from '@bourse/shared-types';
import { SectionCharts } from '@/components/charts/section-charts';

function evidence(degraded = false): { status: 'ready'; data: ChartEvidenceResponse } {
  return {
    status: 'ready',
    data: {
      available: true,
      capturedAt: '2026-08-15T00:00:00.000Z',
      degraded,
      dataAvailability: { complete: [], missing: [], fallbacks: [] },
      chartFacts: {
        quote: {
          price: 100,
          changePct: null,
          currency: 'USD',
          asOf: '2026-08-15',
          pe: 25,
        },
        priceSeries: null,
        technical: null,
        ratios: null,
        valuation: {
          peHistorySeries: [
            { period: 'FY2021', pe: 18 },
            { period: 'FY2022', pe: 22 },
            { period: 'FY2023', pe: 20 },
          ],
          pe5yHigh: 22,
          pe5yMedian: 20,
          pe5yLow: 18,
          pe5yPercentile: 70,
        },
        peerComparison: null,
        northbound: null,
        northboundHoldings: null,
        unlockCalendar: null,
        corporateActions: null,
      },
      provenance: { quote: 'B', financials: 'B' },
    },
  };
}

describe('SectionCharts · degraded and skipped semantics', () => {
  afterEach(() => cleanup());

  it('keeps usable valuation charts visible when evidence is degraded', () => {
    render(
      <SectionCharts
        sectionType="VALUATION_SCENARIOS"
        sectionStatus="completed"
        evidence={evidence(true)}
        structuredJson={{
          scenarios: [{
            case: 'BASE',
            valueRange: { low: 90, high: 110, currency: 'USD' },
          }],
        }}
      />,
    );

    expect(screen.getByText('PE 历史 · 5 年分位带')).toBeTruthy();
    expect(screen.getByText('情景价值区间')).toBeTruthy();
    expect(screen.getAllByText('数据降级：图表基于部分来源生成，请结合数据质量提示阅读')).toHaveLength(2);
  });

  it('shows C2 for skipped valuation but does not invent a C3 empty card', () => {
    render(
      <SectionCharts
        sectionType="VALUATION_SCENARIOS"
        sectionStatus="skipped"
        evidence={evidence()}
        structuredJson={null}
      />,
    );

    expect(screen.getByText('PE 历史 · 5 年分位带')).toBeTruthy();
    expect(screen.queryByText('情景价值区间')).toBeNull();
  });

  it('does not draw a risk chart for a skipped risk module', () => {
    const { container } = render(
      <SectionCharts
        sectionType="RISK_REGISTER"
        sectionStatus="skipped"
        structuredJson={{ risks: [{ title: '风险', likelihood: 'HIGH', impact: 'HIGH' }] }}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
