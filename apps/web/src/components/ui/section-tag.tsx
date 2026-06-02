import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Section tag — the signature `§ SECTION-NAME` micro-label.
 * Render above page H1, above any block-level heading.
 */
export function SectionTag({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'inline-flex items-center font-mono text-[11.5px] uppercase tracking-[0.12em] ' +
          'text-[var(--color-fg-2)]',
        className,
      )}
      {...props}
    >
      <span className="text-[var(--color-fg-3)] mr-1">§</span>
      {children}
    </div>
  );
}
