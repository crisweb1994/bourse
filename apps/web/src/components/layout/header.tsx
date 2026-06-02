'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';

/**
 * Slim mobile menu trigger + route mono-tag. Most controls live in the
 * sidebar foot now — theme toggle, sign out, user identity.
 *
 * Kept as a separate component so the dashboard layout can stay simple.
 */
export function Header({ onMenuClick }: { onMenuClick: () => void }) {
  const pathname = usePathname();

  return (
    <header className="flex h-12 items-center gap-3 border-b border-[var(--color-border)] px-4 lg:px-6 lg:hidden">
      <button
        type="button"
        onClick={onMenuClick}
        className="text-[var(--color-fg)]"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" strokeWidth={1.5} />
      </button>
      <div className="font-mono text-[11px] text-[var(--color-fg-3)] uppercase tracking-[0.12em] truncate">
        {pathname}
      </div>
    </header>
  );
}
