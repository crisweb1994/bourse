import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Sparkline } from '@/components/charts/primitives/sparkline';
import { MetricTrendChart } from '@/components/charts/primitives/metric-trend-chart';
import { UnlockTimeline } from '@/components/charts/primitives/unlock-timeline';
import { PercentileBand } from '@/components/charts/primitives/percentile-band';

describe('primitives · null 安全（P3：无数据不画不抛）', () => {
  it('Sparkline：少于 3 个收盘返回 null', () => {
    const { container } = render(<Sparkline closes={[1, 2]} />);
    expect(container.firstChild).toBeNull();
  });

  it('MetricTrendChart：没有有效点返回 null', () => {
    const { container } = render(
      <MetricTrendChart points={[{ period: '2024-09', value: null, yoyPct: null }]} valueLabel="营收" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('MetricTrendChart：单期数据降级为单柱并明确不可比较', () => {
    const { container } = render(
      <MetricTrendChart points={[{ period: '2024-09', value: 100, yoyPct: null }]} valueLabel="营收" />,
    );
    expect(container.querySelectorAll('svg rect').length).toBe(2); // 背景纹理定义 + 单柱
    expect(container.textContent).toContain('仅 1 期，无法比较趋势');
  });

  it('UnlockTimeline：空事件返回 null', () => {
    const { container } = render(<UnlockTimeline rows={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('PercentileBand：空序列返回 null', () => {
    const { container } = render(<PercentileBand series={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('primitives · 关键回归（review 修复锁定）', () => {
  it('PercentileBand：三块分位色带真实渲染进 SVG（P1-6a）', () => {
    const { container } = render(
      <PercentileBand
        series={[
          { period: 'FY2021', pe: 31 },
          { period: 'FY2022', pe: 21 },
          { period: 'FY2023', pe: 30 },
        ]}
        high={37}
        median={30}
        low={21}
      />,
    );
    const rects = container.querySelectorAll('svg rect');
    // 3 zones + 3 数据点无 rect（是 circle）→ zones 数量恰为 3
    expect(rects.length).toBe(3);
  });

  it('MetricTrendChart：全正同比不裁点（yMin 向下留余量，P2）', () => {
    const { container } = render(
      <MetricTrendChart
        points={[
          { period: '2024-09', value: 100, yoyPct: 5 },
          { period: '2024-12', value: 110, yoyPct: 10 },
          { period: '2025-03', value: 120, yoyPct: 2 },
        ]}
        valueLabel="营收"
      />,
    );
    const circles = container.querySelectorAll('svg circle');
    expect(circles.length).toBe(3);
    // 所有点的 cy 都在 [PT, H-PB] 绘图区内（0..190）
    for (const c of circles) {
      const cy = Number(c.getAttribute('cy'));
      expect(cy).toBeGreaterThanOrEqual(0);
      expect(cy).toBeLessThanOrEqual(190);
    }
  });
});
