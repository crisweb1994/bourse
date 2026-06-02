import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Button — editorial-developer-console primitive.
 *   primary  : black bg, white text
 *   secondary: white bg + border (default)
 *   quiet    : no border, hover bg
 *   danger   : red-tinted outline (used in danger zones)
 */
const buttonVariants = cva(
  // base
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-btn)] ' +
    'font-medium leading-none transition-[background,border-color,color] duration-100 ' +
    'disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--color-fg)] text-[var(--color-bg)] border border-[var(--color-fg)] ' +
            'hover:bg-[#1f1f1f]',
        secondary:
          'bg-[var(--color-bg)] text-[var(--color-fg)] border border-[var(--color-border)] ' +
            'hover:bg-[var(--color-surface-hover)]',
        quiet:
          'bg-transparent text-[var(--color-fg-2)] border border-transparent ' +
            'hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]',
        danger:
          'bg-[var(--color-bg)] text-[var(--color-danger)] border border-[var(--color-danger-line)] ' +
            'hover:bg-[var(--color-danger-soft)]',
      },
      size: {
        sm: 'h-7 px-2.5 text-[12px]',
        md: 'h-9 px-3.5 text-[13px]',
        lg: 'h-11 px-5 text-[13.5px]',
        icon: 'h-7 w-7 p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
