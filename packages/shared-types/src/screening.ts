import { z } from 'zod';

export const SCREENER_METRICS = [
  'MARKET_CAP',
  'NET_INCOME_TTM',
  'PE_TTM',
  'PB',
  'REVENUE_GROWTH_YOY',
  'PRICE',
  'CHANGE_PCT',
  'TURNOVER_RATE',
] as const;

export const ScreenerMetricSchema = z.enum(SCREENER_METRICS);
export type ScreenerMetric = (typeof SCREENER_METRICS)[number];
export const ScreenerOperatorSchema = z.enum(['GTE', 'LTE', 'BETWEEN']);
export type ScreenerOperator = z.infer<typeof ScreenerOperatorSchema>;

export const BoundConditionSchema = z
  .object({
    metric: ScreenerMetricSchema,
    operator: z.enum(['GTE', 'LTE']),
    value: z.number().finite(),
  })
  .strict();

export const RangeConditionSchema = z
  .object({
    metric: ScreenerMetricSchema,
    operator: z.literal('BETWEEN'),
    min: z.number().finite(),
    max: z.number().finite(),
  })
  .strict();

export const ScreeningConditionSchema = z.union([
  BoundConditionSchema,
  RangeConditionSchema,
]);
export type ScreeningCondition = z.infer<typeof ScreeningConditionSchema>;

export const ScreeningQuerySchema = z
  .object({
    market: z.enum(['US', 'CN', 'HK']),
    universe: z.literal('ACTIVE_COMMON_STOCKS'),
    conditions: z.array(ScreeningConditionSchema).min(1).max(20),
    sort: z
      .object({
        metric: ScreenerMetricSchema,
        direction: z.enum(['ASC', 'DESC']),
      })
      .strict(),
  })
  .strict()
  .superRefine((query, ctx) => {
    const bounds = new Map<
      ScreenerMetric,
      { lower?: number; upper?: number; conditionIndex: number }
    >();
    query.conditions.forEach((condition, index) => {
      if (condition.operator === 'BETWEEN' && condition.min > condition.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conditions', index, 'min'],
          message: 'BETWEEN min must be less than or equal to max.',
        });
        return;
      }
      const current = bounds.get(condition.metric) ?? { conditionIndex: index };
      const lower = condition.operator === 'GTE'
        ? condition.value
        : condition.operator === 'BETWEEN'
          ? condition.min
          : undefined;
      const upper = condition.operator === 'LTE'
        ? condition.value
        : condition.operator === 'BETWEEN'
          ? condition.max
          : undefined;
      bounds.set(condition.metric, {
        lower: lower === undefined ? current.lower : Math.max(current.lower ?? -Infinity, lower),
        upper: upper === undefined ? current.upper : Math.min(current.upper ?? Infinity, upper),
        conditionIndex: index,
      });
    });
    for (const [metric, bound] of bounds) {
      if (bound.lower !== undefined && bound.upper !== undefined && bound.lower > bound.upper) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conditions', bound.conditionIndex],
          message: `Conditions for ${metric} have contradictory bounds.`,
        });
      }
    }
  });
export type ScreeningQuery = z.infer<typeof ScreeningQuerySchema>;

export const SCREENING_VIEW_COLUMNS = [
  'SECURITY',
  'PRICE',
  'SORT_METRIC',
  'CONDITION_MATCH',
  'REFINE_STATUS',
  'PE',
  'PB',
  'ROE',
  'RSI14',
] as const;
export type ScreeningViewColumn = (typeof SCREENING_VIEW_COLUMNS)[number];

export const ScreeningViewSchema = z
  .object({
    visibleColumns: z
      .array(z.enum(SCREENING_VIEW_COLUMNS))
      .min(1)
      .max(SCREENING_VIEW_COLUMNS.length),
    displaySort: z
      .object({
        column: z.enum(SCREENING_VIEW_COLUMNS),
        direction: z.enum(['ASC', 'DESC']),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((view, ctx) => {
    if (new Set(view.visibleColumns).size !== view.visibleColumns.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['visibleColumns'],
        message: 'Columns must be unique.',
      });
    }
  });
export type ScreeningView = z.infer<typeof ScreeningViewSchema>;

export const SavedScreenPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    query: ScreeningQuerySchema,
    view: ScreeningViewSchema,
  })
  .strict();
export type SavedScreenPayload = z.infer<typeof SavedScreenPayloadSchema>;

export const SavedScreenPatchSchema = SavedScreenPayloadSchema.partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });
export type SavedScreenPatch = z.infer<typeof SavedScreenPatchSchema>;

export const CreateScreeningRunRequestSchema = z
  .object({
    query: ScreeningQuerySchema,
    savedScreenId: z.string().min(1).optional(),
  })
  .strict();
export type CreateScreeningRunRequest = z.infer<
  typeof CreateScreeningRunRequestSchema
>;

export const RefineScreeningRunRequestSchema = z
  .object({
    identityKeys: z.array(z.string().min(3)).min(1).max(5),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.identityKeys).size !== value.identityKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityKeys'],
        message: 'Candidate identities must be unique.',
      });
    }
  });
export type RefineScreeningRunRequest = z.infer<
  typeof RefineScreeningRunRequestSchema
>;

export const SCREENING_METRIC_UNITS = {
  MARKET_CAP: 'CURRENCY',
  NET_INCOME_TTM: 'CURRENCY',
  PE_TTM: 'RATIO',
  PB: 'RATIO',
  REVENUE_GROWTH_YOY: 'PERCENT',
  PRICE: 'CURRENCY',
  CHANGE_PCT: 'PERCENT',
  TURNOVER_RATE: 'PERCENT',
} as const satisfies Record<ScreenerMetric, 'RATIO' | 'PERCENT' | 'CURRENCY'>;

export const ScreeningMetricCellSchema = z
  .object({
    status: z.enum([
      'PRESENT',
      'MISSING',
      'NOT_APPLICABLE',
      'FETCH_FAILED',
    ]),
    value: z.union([z.number().finite(), z.string(), z.null()]),
    unit: z.enum(['RATIO', 'PERCENT', 'CURRENCY', 'COUNT', 'ENUM']),
    sourceId: z.string().min(1),
    asOf: z.string().nullable(),
    estimated: z.boolean(),
    note: z.string().optional(),
  })
  .strict();
export type ScreeningMetricCell = z.infer<typeof ScreeningMetricCellSchema>;

export const ScreeningMetricRecordSchema = z
  .object({
    MARKET_CAP: ScreeningMetricCellSchema,
    NET_INCOME_TTM: ScreeningMetricCellSchema,
    PE_TTM: ScreeningMetricCellSchema,
    PB: ScreeningMetricCellSchema,
    REVENUE_GROWTH_YOY: ScreeningMetricCellSchema,
    PRICE: ScreeningMetricCellSchema,
    CHANGE_PCT: ScreeningMetricCellSchema,
    TURNOVER_RATE: ScreeningMetricCellSchema,
  })
  .strict();

export const ScreeningCandidateRowSchema = z
  .object({
    identityKey: z.string().min(3),
    symbol: z.string().min(1),
    name: z.string().nullable(),
    exchange: z.string().nullable(),
    currency: z.string().min(1),
    metrics: ScreeningMetricRecordSchema,
    matchedConditionIndexes: z.array(z.number().int().nonnegative()),
  })
  .strict();
export type ScreeningCandidateRow = z.infer<typeof ScreeningCandidateRowSchema>;

export const ScreeningWarningSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().max(500),
    provider: z.string().min(1).max(100).optional(),
    retryAfterMs: z.number().int().nonnegative().max(86_400_000).optional(),
  })
  .strict();
export type ScreeningWarning = z.infer<typeof ScreeningWarningSchema>;

export const EquityScreenerSnapshotSchema = z
  .object({
    universeCount: z.number().int().nonnegative(),
    matchedCount: z.number().int().nonnegative(),
    providerAsOf: z.string().datetime(),
    complete: z.boolean(),
    truncated: z.boolean(),
    conditionCounts: z.array(z.number().int().nonnegative()).optional(),
    warnings: z.array(ScreeningWarningSchema).max(20).optional(),
    items: z.array(ScreeningCandidateRowSchema).max(200),
  })
  .strict();
export type EquityScreenerSnapshot = z.infer<typeof EquityScreenerSnapshotSchema>;

export const ScreeningRefinementPayloadSchema = z
  .object({
    status: z.enum(['COMPLETE', 'PARTIAL']),
    cells: z.record(z.string(), ScreeningMetricCellSchema),
    warnings: z.array(z.string()),
    completedAt: z.string().datetime(),
  })
  .strict();
export type ScreeningRefinementPayload = z.infer<typeof ScreeningRefinementPayloadSchema>;

export const ScreeningConfigSchema = z
  .object({
    market: z.enum(['US', 'CN', 'HK']),
    available: z.boolean(),
    unavailableReason: z.string().nullable(),
    sourceId: z.string().nullable(),
    metrics: z.array(
      z
        .object({
          metric: ScreenerMetricSchema,
          operators: z.array(ScreenerOperatorSchema),
        })
        .strict(),
    ),
    sortableMetrics: z.array(ScreenerMetricSchema),
    delay: z.enum(['realtime', 'delayed', 'eod']).nullable(),
    universeLabel: z.string(),
    universeRules: z.array(z.string()),
    presets: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          query: ScreeningQuerySchema,
        })
        .strict(),
    ),
  })
  .strict();
export type ScreeningConfig = z.infer<typeof ScreeningConfigSchema>;

export const SavedScreenDtoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    query: ScreeningQuerySchema,
    view: ScreeningViewSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type SavedScreenDto = z.infer<typeof SavedScreenDtoSchema>;

export const ScreeningRefinementDtoSchema = z
  .object({
    identityKey: z.string(),
    payload: ScreeningRefinementPayloadSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ScreeningRefinementDto = z.infer<
  typeof ScreeningRefinementDtoSchema
>;

export const ScreeningRunDtoSchema = z
  .object({
    id: z.string(),
    savedScreenId: z.string().nullable(),
    status: z.enum(['COMPLETE', 'PARTIAL']),
    query: ScreeningQuerySchema,
    sourceId: z.string(),
    capturedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    snapshot: EquityScreenerSnapshotSchema,
    view: ScreeningViewSchema,
    refinements: z.array(ScreeningRefinementDtoSchema),
  })
  .strict();
export type ScreeningRunDto = z.infer<typeof ScreeningRunDtoSchema>;

export const RefineCandidateResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      identityKey: z.string(),
      status: z.enum(['COMPLETE', 'PARTIAL']),
      refinement: ScreeningRefinementDtoSchema,
    })
    .strict(),
  z
    .object({
      identityKey: z.string(),
      status: z.literal('FAILED'),
      error: z.string(),
    })
    .strict(),
]);
export type RefineCandidateResult = z.infer<
  typeof RefineCandidateResultSchema
>;

export const RefineResponseSchema = z
  .object({
    results: z.array(RefineCandidateResultSchema).min(1).max(5),
  })
  .strict();
export type RefineResponse = z.infer<typeof RefineResponseSchema>;
