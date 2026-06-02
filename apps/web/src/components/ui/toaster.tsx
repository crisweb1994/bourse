'use client';

import { Toaster as SonnerToaster, toast } from 'sonner';
import { useTheme } from 'next-themes';

/**
 * Toaster — sonner wrapper themed to our editorial token language.
 * Mount once at the app root. Use `toast.success / .error / .info / .message`
 * from anywhere; this re-exports `toast` for convenience.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();

  return (
    <SonnerToaster
      theme={(resolvedTheme as 'light' | 'dark') ?? 'light'}
      position="bottom-right"
      richColors={false}
      closeButton={false}
      duration={3500}
      offset={20}
      toastOptions={{
        unstyled: false,
        classNames: {
          toast:
            'group flex items-center gap-3 rounded-[var(--radius-card)] ' +
            'border border-[var(--color-border)] bg-[var(--color-bg)] ' +
            'px-4 py-3 text-[13px] text-[var(--color-fg)] font-sans w-full',
          title: 'text-[13px] font-medium text-[var(--color-fg)]',
          description: 'text-[12px] text-[var(--color-fg-2)] mt-0.5',
          actionButton:
            'rounded-[var(--radius-btn)] border border-[var(--color-fg)] ' +
            'bg-[var(--color-fg)] text-[var(--color-bg)] px-2.5 py-1 text-[12px] font-medium',
          cancelButton:
            'rounded-[var(--radius-btn)] border border-[var(--color-border)] ' +
            'bg-[var(--color-bg)] text-[var(--color-fg-2)] px-2.5 py-1 text-[12px]',
          success: 'border-l-[3px] border-l-[var(--color-accent)]',
          error: 'border-l-[3px] border-l-[var(--color-danger)]',
          info: 'border-l-[3px] border-l-[var(--color-info)]',
          warning: 'border-l-[3px] border-l-[var(--color-warn)]',
        },
      }}
    />
  );
}

export { toast };
