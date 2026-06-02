import type { HTMLAttributes, TableHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Minimal table — only horizontal dividers, no vertical lines, no zebra.
 * Wrap inside a <Card> when you want the bordered shell + footer.
 */
export function Table({
  className,
  ...props
}: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table
      className={cn('w-full border-collapse text-[13.5px]', className)}
      {...props}
    />
  );
}

export function THead({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        '[&_th]:font-mono [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-[0.1em] ' +
          '[&_th]:text-[var(--color-fg-2)] [&_th]:font-normal [&_th]:text-left ' +
          '[&_th]:px-4 [&_th]:py-3 [&_th]:border-b [&_th]:border-[var(--color-border)]',
        className,
      )}
      {...props}
    />
  );
}

export function TBody({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn(
        '[&_td]:px-4 [&_td]:py-3.5 [&_td]:border-b [&_td]:border-[var(--color-border-soft)] [&_td]:align-middle ' +
          '[&_tr:last-child_td]:border-b-0 [&_tr]:transition-colors [&_tr]:duration-100 ' +
          'hover:[&_tr]:bg-[var(--color-surface-hover)]',
        className,
      )}
      {...props}
    />
  );
}

export function TFoot({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-3 ' +
          'border-t border-[var(--color-border-soft)] ' +
          'text-[12.5px] text-[var(--color-fg-2)]',
        className,
      )}
      {...props}
    />
  );
}

/** Mono ticker symbol cell content. */
export function Sym({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'font-mono font-medium text-[var(--color-fg)] tracking-[0.02em]',
        className,
      )}
    >
      {children}
    </span>
  );
}
