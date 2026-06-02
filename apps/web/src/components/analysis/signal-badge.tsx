'use client';

import { Pill, type PillProps } from '@/components/ui';
import { SIGNAL_LABELS, CONFIDENCE_LABELS } from '@/lib/constants';

// PR-9 · Style A signal mapping. Bull = sage-on-forest (accent-soft),
// bear = brick-on-warm-pink (danger-soft), neutral = neutral pill.
const SIGNAL_VARIANT: Record<string, PillProps['variant']> = {
  BULLISH: 'emerald',
  NEUTRAL: 'neutral',
  BEARISH: 'danger',
};

export function SignalBadge({
  signal,
  confidence,
  className,
}: {
  signal: string;
  confidence?: string;
  className?: string;
}) {
  return (
    <Pill variant={SIGNAL_VARIANT[signal] || 'neutral'} className={className}>
      {SIGNAL_LABELS[signal] || signal}
      {confidence && (
        <span className="opacity-70 ml-1">
          · 置信度{CONFIDENCE_LABELS[confidence] || confidence}
        </span>
      )}
    </Pill>
  );
}
