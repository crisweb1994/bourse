import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Pill — small uppercase mono label. Used for status / category.
 * Variants:
 *   neutral (default) — bordered white
 *   solid             — black bg, white text (e.g. SIGNAL · BULLISH)
 *   emerald           — accent-soft bg (e.g. COMPLETE, PRIMARY)
 *   blue              — info pill (e.g. SOURCE · ENV)
 *   warn              — amber pill (PARTIAL, STALE)
 *   danger            — red pill (FAILED, EXPIRED)
 *   flat              — no border, used for inline meta
 */
const pillVariants = cva(
  'inline-flex items-center gap-1 rounded-[var(--radius-pill)] ' +
    'font-mono text-[11px] uppercase tracking-[0.06em] leading-[1.6] ' +
    'px-2 py-[1px]',
  {
    variants: {
      variant: {
        neutral:
          'border border-[var(--color-border)] text-[var(--color-fg-2)] bg-[var(--color-bg)]',
        solid:
          'border border-[var(--color-fg)] bg-[var(--color-fg)] text-[var(--color-bg)]',
        emerald:
          'border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-[var(--color-accent-600)]',
        blue:
          'border border-[var(--color-info-line)] bg-[var(--color-info-soft)] text-[var(--color-info)]',
        warn:
          'border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] text-[var(--color-warn)]',
        danger:
          'border border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
        flat:
          'border border-transparent text-[var(--color-fg-2)] px-1',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface PillProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof pillVariants> {
  dot?: boolean;
}

export function Pill({ className, variant, dot, children, ...props }: PillProps) {
  return (
    <span className={cn(pillVariants({ variant }), className)} {...props}>
      {dot && (
        <span className="w-[5px] h-[5px] rounded-full bg-current inline-block" />
      )}
      {children}
    </span>
  );
}
