const DEFAULT_ANALYSIS_CONCURRENCY = 4;

export function parseAnalysisConcurrency(value: string | undefined): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_ANALYSIS_CONCURRENCY;
  return Math.max(1, parsed);
}
