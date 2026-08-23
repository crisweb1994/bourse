import type {
  ScreeningConfig,
  ScreeningCondition,
  ScreeningQuery,
} from '@bourse/shared-types';
import type { EquityScreenerDescriptor } from '@bourse/market-data';

type PresetDefinition = Omit<ScreeningConfig['presets'][number], 'query'> & {
  conditions: ScreeningCondition[];
  sort: ScreeningQuery['sort'];
};

const PRESETS: readonly PresetDefinition[] = [
  {
    id: 'large-cap',
    name: '大市值',
    description: '按公开市值条件缩小候选范围。',
    conditions: [
      { metric: 'MARKET_CAP', operator: 'GTE', value: 10_000_000_000 },
    ],
    sort: { metric: 'MARKET_CAP', direction: 'DESC' },
  },
  {
    id: 'moderate-valuation',
    name: '适中估值',
    description: '按公开估值区间缩小候选，不生成综合评分。',
    conditions: [
      { metric: 'PE_TTM', operator: 'BETWEEN', min: 0.01, max: 25 },
      { metric: 'PB', operator: 'LTE', value: 4 },
    ],
    sort: { metric: 'PE_TTM', direction: 'ASC' },
  },
  {
    id: 'active-trading',
    name: '活跃交易',
    description: '按换手率和当日涨跌幅寻找交投活跃的候选。',
    conditions: [
      { metric: 'TURNOVER_RATE', operator: 'GTE', value: 0.02 },
      { metric: 'CHANGE_PCT', operator: 'BETWEEN', min: -0.1, max: 0.1 },
    ],
    sort: { metric: 'TURNOVER_RATE', direction: 'DESC' },
  },
];

export function availablePresets(
  market: ScreeningQuery['market'],
  descriptor: EquityScreenerDescriptor,
): ScreeningConfig['presets'] {
  const capabilities = new Map(
    descriptor.metrics.map((entry) => [entry.metric, new Set(entry.operators)]),
  );
  const sortable = new Set(descriptor.sortableMetrics);

  return PRESETS.filter(
    (preset) =>
      sortable.has(preset.sort.metric) &&
      preset.conditions.every((condition) =>
        capabilities.get(condition.metric)?.has(condition.operator),
      ),
  ).map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    query: {
      market,
      universe: 'ACTIVE_COMMON_STOCKS',
      conditions: preset.conditions,
      sort: preset.sort,
    },
  }));
}
