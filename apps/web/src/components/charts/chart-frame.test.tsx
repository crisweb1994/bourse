import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChartFrame } from '@/components/charts/chart-frame';

describe('ChartFrame · 四态契约（V3/V5 唯一执行点）', () => {
  it('loading 态渲染骨架占位', () => {
    render(<ChartFrame title="测试图" status="loading" />);
    expect(screen.getByText('图表数据加载中…')).toBeTruthy();
  });

  it('empty 态渲染结构化原因，不画图', () => {
    render(
      <ChartFrame
        title="测试图"
        status="empty"
        emptyReason={{ code: 'no_data', message: '暂无行情历史数据' }}
      />,
    );
    expect(screen.getByText('暂无行情历史数据')).toBeTruthy();
    expect(screen.getByText('no_data')).toBeTruthy();
  });

  it('ready + degradedNote 渲染降级黄条与 children', () => {
    render(
      <ChartFrame title="测试图" status="ready" degradedNote="数据降级提示">
        <div data-testid="plot">plot</div>
      </ChartFrame>,
    );
    expect(screen.getByText('数据降级提示')).toBeTruthy();
    expect(screen.getByTestId('plot')).toBeTruthy();
  });

  it('a11y：figure role=group + figcaption 摘要', () => {
    render(
      <ChartFrame title="信号矩阵" status="ready" ariaSummary="五模块信号概览">
        <div />
      </ChartFrame>,
    );
    expect(screen.getByRole('group', { name: '信号矩阵' })).toBeTruthy();
    expect(screen.getByText('五模块信号概览')).toBeTruthy();
  });

  it('dataAsOf / sourceTier 徽标', () => {
    render(
      <ChartFrame title="测试图" status="ready" asOf="2026-08-15T10:00:00Z" sourceTier="B">
        <div />
      </ChartFrame>,
    );
    expect(screen.getByText(/dataAsOf 2026-08-15/)).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });
});
