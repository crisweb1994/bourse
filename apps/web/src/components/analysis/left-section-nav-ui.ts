export type NavStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'skipped';

export const NAV_ACTIVE_RAIL_CLASS =
  'absolute left-0 top-1/2 h-[34px] w-[2px] -translate-y-1/2 bg-[var(--color-fg)]';

export const NAV_ITEM_BASE_CLASS =
  'flex w-full items-center gap-3 py-2.5 pl-7 pr-2 text-left text-[15px] leading-none transition-colors duration-100';

export const NAV_MARKER_BASE_CLASS =
  'grid h-3.5 w-3.5 shrink-0 place-items-center font-mono text-[14px] leading-none';

export function getNavStatusMarker(status: NavStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'completed':
      return { label: '●', className: 'text-[var(--color-accent)]' };
    case 'streaming':
      return { label: '◐', className: 'text-[var(--color-accent-600)]' };
    case 'failed':
      return { label: '×', className: 'text-[var(--color-danger)]' };
    case 'skipped':
      return { label: '—', className: 'text-[var(--color-warn)]' };
    case 'pending':
    default:
      return { label: '○', className: 'text-[var(--color-fg-4)]' };
  }
}
