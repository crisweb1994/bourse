/** Deterministic serialization for cache inputs. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function cacheKey(parts: {
  sourceId: string;
  capability: string;
  dataSet?: string;
  seriesCode?: string;
  scope: string;
  input: unknown;
  normalizationVersion?: string;
}): string {
  return [
    'market-data-v2',
    parts.normalizationVersion ?? '1',
    parts.scope,
    parts.sourceId,
    parts.capability,
    parts.dataSet ?? '-',
    parts.seriesCode ?? '-',
    stableJson(parts.input),
  ].join(':');
}
