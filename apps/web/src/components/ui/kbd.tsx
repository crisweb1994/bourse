import { cn } from '@/lib/utils';

/**
 * Kbd — keyboard shortcut hint. Mono, bordered, small.
 *   <Kbd>⌘ K</Kbd>
 */
export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'font-mono text-[10.5px] leading-none ' +
          'text-[var(--color-fg-2)] border border-[var(--color-border)] ' +
          'rounded-[4px] px-1.5 py-[2px] bg-[var(--color-bg)]',
        className,
      )}
    >
      {children}
    </span>
  );
}
