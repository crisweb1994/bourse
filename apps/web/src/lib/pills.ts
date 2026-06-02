import type { PillProps } from '@/components/ui';

/** Analysis status → Pill variant. Shared by the home + history lists. */
export function statusPillVariant(status: string): PillProps['variant'] {
  switch (status) {
    case 'COMPLETED':
      return 'emerald';
    case 'PARTIAL_FAILED':
      return 'warn';
    case 'FAILED':
    case 'CANCELLED':
      return 'danger';
    case 'IN_PROGRESS':
      return 'blue';
    default:
      return 'neutral';
  }
}

/** Overall signal → Pill variant; null when there's no signal to show. */
export function signalPillVariant(
  signal: string | null | undefined,
): PillProps['variant'] | null {
  if (!signal) return null;
  if (signal === 'BULLISH') return 'solid';
  if (signal === 'BEARISH') return 'warn';
  return 'neutral';
}
