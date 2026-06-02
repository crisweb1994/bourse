import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Input shell — bordered row with optional leading icon and trailing slot.
 * Fixed height (h-10 / 40px) so leading + trailing line up cleanly with
 * the inner input regardless of which slots are populated.
 *
 * `sans=true` overrides the default mono font on the inner <input>.
 */
export interface InputShellProps {
  leading?: ReactNode;
  trailing?: ReactNode;
  sans?: boolean;
  className?: string;
  children: ReactNode;
}

export function InputShell({
  leading,
  trailing,
  sans,
  className,
  children,
}: InputShellProps) {
  return (
    <div
      className={cn(
        'flex items-center h-10 rounded-[var(--radius-btn)] border border-[var(--color-border)] ' +
          'bg-[var(--color-bg)] transition-colors duration-100 ' +
          'focus-within:border-[var(--color-fg)]',
        sans && '[&_input]:font-sans [&_input]:text-[14px]',
        className,
      )}
    >
      {leading != null && (
        <span className="pl-3 text-[var(--color-fg-3)] flex items-center shrink-0 [&_svg]:w-[15px] [&_svg]:h-[15px]">
          {leading}
        </span>
      )}
      {children}
      {trailing != null && (
        <span className="pr-2 pl-1 flex items-center gap-1.5 shrink-0">
          {trailing}
        </span>
      )}
    </div>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'flex-1 min-w-0 bg-transparent border-0 outline-none h-full px-3 ' +
        'font-mono text-[13px] text-[var(--color-fg)] ' +
        'placeholder:text-[var(--color-fg-3)]',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
