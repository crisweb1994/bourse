import { type HTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Card — white bg, 1px border, 12px radius. NO SHADOW EVER.
 * Use <CardHead/> for the title bar, <CardBody/> for padded content.
 */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-[var(--radius-card)] border border-[var(--color-border)] ' +
          'bg-[var(--color-bg-elev)] overflow-hidden',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export function CardHead({
  className,
  children,
  hint,
  ...props
}: HTMLAttributes<HTMLDivElement> & { hint?: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-[22px] py-4 border-b border-[var(--color-border-soft)]',
        className,
      )}
      {...props}
    >
      <div className="text-[14px] font-medium">{children}</div>
      {hint != null && (
        <div className="font-mono text-[12px] text-[var(--color-fg-3)] tracking-[0.04em]">
          {hint}
        </div>
      )}
    </div>
  );
}

export function CardBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-[22px] py-5', className)} {...props} />;
}
