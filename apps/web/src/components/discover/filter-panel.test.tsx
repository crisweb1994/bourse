import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScreeningConfig } from '@bourse/shared-types';
import { FilterPanel, type ConditionDraft } from './filter-panel';

const CONFIG: ScreeningConfig = {
  market: 'CN',
  available: true,
  unavailableReason: null,
  sourceId: 'test-screener',
  metrics: [{ metric: 'MARKET_CAP', operators: ['GTE', 'LTE', 'BETWEEN'] }],
  sortableMetrics: ['MARKET_CAP'],
  delay: 'delayed',
  universeLabel: '测试股票池',
  universeRules: [],
  presets: [],
};

const CONDITIONS: ConditionDraft[] = [
  {
    metric: 'MARKET_CAP',
    operator: 'GTE',
    value: '1',
    min: '',
    max: '',
  },
];

describe('FilterPanel mobile dialog', () => {
  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  it('unmounts the mobile surface while closed and manages modal focus when open', async () => {
    const { container } = render(<Harness />);
    const trigger = screen.getByRole('button', { name: '打开筛选条件' });

    expect(screen.queryByRole('dialog', { name: '筛选条件' })).not.toBeInTheDocument();
    expect(container.querySelector('aside.fixed')).not.toBeInTheDocument();
    expect(container.querySelector('aside')).toHaveClass('hidden');

    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '筛选条件' });
    expect(document.body.style.overflow).toBe('hidden');
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    expect(within(dialog).getByRole('button', { name: '关闭筛选条件' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '筛选条件' })).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe('');
      expect(trigger).toHaveFocus();
    });
  });
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开筛选条件
      </button>
      <FilterPanel
        open={open}
        config={CONFIG}
        conditions={CONDITIONS}
        sortMetric="MARKET_CAP"
        sortDirection="DESC"
        selectedPresetId={null}
        errorIndex={null}
        running={false}
        onClose={() => setOpen(false)}
        onChangeCondition={vi.fn()}
        onRemoveCondition={vi.fn()}
        onAddCondition={vi.fn()}
        onApplyPreset={vi.fn()}
        onReset={vi.fn()}
        onChangeSortMetric={vi.fn()}
        onChangeSortDirection={vi.fn()}
        onRun={vi.fn()}
      />
    </>
  );
}
