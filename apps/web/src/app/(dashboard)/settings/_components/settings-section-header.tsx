import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SettingsSectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'mb-6 flex flex-col gap-4 border-b border-[var(--color-border-soft)] pb-5 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="m-0 text-[20px] font-semibold leading-[1.3]">{title}</h2>
        {description && (
          <p className="mt-1.5 max-w-[68ch] text-[13px] leading-[1.6] text-[var(--color-fg-2)]">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
