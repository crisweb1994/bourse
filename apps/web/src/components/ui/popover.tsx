'use client';

/**
 * Dialog — Style A lightweight a11y primitive.
 *
 * Centered overlay with backdrop + scroll lock + ESC/click-outside close +
 * focus trap. Use when the surface owns the user's attention (new-analysis
 * form, diff). Built without Radix to keep bundle size flat.
 */
import { type ReactNode, useCallback, useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/utils';

// ============================================================================
// Dialog
// ============================================================================

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible label; renders as visually-hidden if titleSlot omitted. */
  ariaLabel: string;
  /** Optional rendered title above the body. */
  titleSlot?: ReactNode;
  children: ReactNode;
  /** Tailwind max-width class; default `max-w-lg`. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const DIALOG_SIZE: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export function Dialog({
  open,
  onOpenChange,
  ariaLabel,
  titleSlot,
  children,
  size = 'md',
  className,
}: DialogProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousActive = useRef<Element | null>(null);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Scroll lock + escape + focus management.
  useEffect(() => {
    if (!open) return;
    previousActive.current = document.activeElement;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') close();
      if (ev.key === 'Tab') trapTab(ev, panelRef.current);
    }
    document.addEventListener('keydown', handleKey);

    // Defer focus to next tick so the panel exists.
    const t = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), a, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panelRef.current)?.focus({ preventScroll: true });
    }, 0);

    return () => {
      document.body.style.overflow = original;
      document.removeEventListener('keydown', handleKey);
      window.clearTimeout(t);
      (previousActive.current as HTMLElement | null)?.focus?.({
        preventScroll: true,
      });
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="presentation"
      onMouseDown={(e) => {
        // Click on backdrop (not panel) closes.
        if (e.target === e.currentTarget) close();
      }}
    >
      {/* Backdrop */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[rgba(20,18,14,0.36)]"
        onMouseDown={close}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={titleSlot ? undefined : ariaLabel}
        aria-labelledby={titleSlot ? `${id}-title` : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-[92vw] rounded-[var(--radius-card)] ' +
            'border border-[var(--color-border)] bg-[var(--color-bg-elev)] ' +
            'max-h-[88vh] overflow-y-auto',
          DIALOG_SIZE[size],
          className,
        )}
      >
        {titleSlot && (
          <div
            id={`${id}-title`}
            className="border-b border-[var(--color-border-soft)] px-5 py-3.5 text-[14px] font-medium"
          >
            {titleSlot}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function trapTab(ev: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const focusables = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) {
    ev.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (ev.shiftKey && active === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
}
