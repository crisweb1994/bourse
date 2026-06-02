import type { ReactNode } from 'react';
import { SectionTag } from './section-tag';
import { cn } from '@/lib/utils';

/**
 * PageHeader — section tag + H1 + one-line gray subtitle.
 * Used at the top of every dashboard route.
 */
export interface PageHeaderProps {
  tag: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  tag,
  title,
  subtitle,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('mb-12', className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionTag className="mb-3.5">{tag}</SectionTag>
          <h1 className="text-[28px] font-semibold tracking-[-0.015em] leading-[1.2] m-0 mb-2.5">
            {title}
          </h1>
          {subtitle && (
            <p className="text-[14px] text-[var(--color-fg-2)] max-w-[720px] m-0 leading-[1.55]">
              {subtitle}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0 mt-1">{actions}</div>
        )}
      </div>
    </header>
  );
}

/**
 * SectionHead — used inside a page to introduce a sub-section.
 * Smaller than PageHeader; pairs an H2 with optional hint + actions.
 */
export interface SectionHeadProps {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function SectionHead({
  title,
  hint,
  actions,
  className,
}: SectionHeadProps) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 mb-4', className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[20px] font-semibold tracking-[-0.01em] m-0">
          {title}
        </h2>
        {hint && (
          <span className="text-[13px] text-[var(--color-fg-2)]">{hint}</span>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
