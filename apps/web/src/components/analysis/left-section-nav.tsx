'use client';

/**
 * PR-8 + S3-5 · Style A · Editorial Refined navigation.
 *
 * Two layouts via the same component:
 *  - lg+ : sticky vertical list (status dot + label, active = border-left)
 *  - < lg: sticky horizontal scrolling chip row (status dot inline,
 *          active = bg accent-soft + accent text). Saves vertical room
 *          on mobile where the 3-col grid stacks.
 *
 * Auto-scroll: when activeId changes on the horizontal layout, the
 * active chip is centred via `scrollIntoView({inline: 'center'})`.
 */
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  NAV_ACTIVE_RAIL_CLASS,
  NAV_ITEM_BASE_CLASS,
  NAV_MARKER_BASE_CLASS,
  getNavStatusMarker,
  type NavStatus,
} from './left-section-nav-ui';

export interface NavItem {
  id: string;
  label: string;
  status: NavStatus;
  isSummary?: boolean;
}

interface Props {
  items: NavItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function LeftSectionNav({ items, activeId, onSelect }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeId || !stripRef.current) return;
    const el = stripRef.current.querySelector<HTMLElement>(
      `[data-nav-id="${activeId}"]`,
    );
    el?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
  }, [activeId]);

  if (items.length === 0) return null;

  return (
    <nav className="sticky top-0 z-10 self-start lg:top-2">
      {/* lg+ vertical list */}
      <ul className="m-0 hidden list-none p-0 pt-1 lg:block">
        {items.map((item) => {
          const isActive = activeId === item.id;
          return (
            <li
              key={item.id}
              className={cn(
                'relative',
                item.isSummary &&
                  'mt-6 border-t border-[var(--color-border-soft)] pt-5',
              )}
            >
              {isActive && (
                <span aria-hidden className={NAV_ACTIVE_RAIL_CLASS} />
              )}
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={cn(
                  NAV_ITEM_BASE_CLASS,
                  isActive
                    ? 'font-semibold text-[var(--color-fg)]'
                    : 'font-normal text-[var(--color-fg-2)] hover:text-[var(--color-fg)]',
                )}
              >
                <StatusDot status={item.status} />
                <span className="truncate">{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* < lg horizontal scrolling chip row */}
      <div
        ref={stripRef}
        className={cn(
          'flex gap-1.5 overflow-x-auto border-b border-[var(--color-border-soft)] bg-[var(--color-bg)] px-1 py-2',
          'lg:hidden',
          // Hide the scrollbar — the chips reveal scrollability via overflow.
          '[&::-webkit-scrollbar]:h-0',
          '[scrollbar-width:none]',
        )}
        role="tablist"
        aria-label="维度导航"
      >
        {items.map((item) => {
          const isActive = activeId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-nav-id={item.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(item.id)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-btn)] px-3 py-1.5 text-[12.5px] transition-colors',
                isActive
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-600)] font-semibold'
                  : 'text-[var(--color-fg-2)] hover:text-[var(--color-fg)]',
                item.isSummary &&
                  !isActive &&
                  'ml-2 border-l border-[var(--color-border-soft)] pl-3',
              )}
            >
              <StatusDot status={item.status} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function StatusDot({ status }: { status: NavItem['status'] }) {
  const marker = getNavStatusMarker(status);
  return (
    <span aria-hidden className={cn(NAV_MARKER_BASE_CLASS, marker.className)}>
      {marker.label}
    </span>
  );
}
