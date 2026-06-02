'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Home,
  Pin,
  History,
  User,
  Cpu,
  X,
  ChevronsUpDown,
  LogOut,
  Moon,
  Sun,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn, API_URL, csrfHeaders } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui';
import type { UserDto } from '@bourse/shared-types';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

const WORKSPACE_NAV: NavItem[] = [
  { href: '/', label: '首页', icon: Home },
  { href: '/watchlist', label: '自选股', icon: Pin },
  { href: '/history', label: '历史记录', icon: History },
];

const ACCOUNT_NAV: NavItem[] = [
  { href: '/settings/profile', label: '账户', icon: User },
  { href: '/settings/ai', label: 'AI 模型', icon: Cpu },
];

export function Sidebar({
  open,
  onClose,
  user,
}: {
  open: boolean;
  onClose: () => void;
  user: UserDto | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const isAnonymous = user?.githubId === '__local__';

  const handleLogout = async () => {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: csrfHeaders(),
    });
    router.push('/login');
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-[220px] flex flex-col ' +
            'border-r border-[var(--color-border)] bg-[var(--color-surface-2)] ' +
            'transition-transform ',
          'lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shrink-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-4 pt-5 pb-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/bourse-logo.svg" alt="Bourse" className="h-7 w-auto" />
          <button
            onClick={onClose}
            className="ml-auto lg:hidden text-[var(--color-fg-2)]"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <NavGroup
          label="工作台"
          items={WORKSPACE_NAV}
          pathname={pathname}
          onItemClick={onClose}
          className="px-3 pt-7"
        />
        <NavGroup
          label="账户"
          items={ACCOUNT_NAV}
          pathname={pathname}
          onItemClick={onClose}
          className="px-3 pt-6"
        />

        <div className="mt-auto px-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2.5 border-t border-[var(--color-border)] ' +
                    'px-2 py-3.5 text-left transition-colors outline-none ' +
                    'data-[state=open]:bg-[var(--color-bg)]',
                )}
              >
                <span
                  className={cn(
                    'w-6 h-6 rounded-[6px] grid place-items-center text-[11px] font-medium ' +
                      'border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)]',
                  )}
                >
                  {user?.name?.charAt(0).toUpperCase() || 'U'}
                </span>
                <span className="flex flex-col min-w-0 leading-tight">
                  <span className="text-[13px] font-medium text-[var(--color-fg)] truncate">
                    {user?.name || '用户'}
                  </span>
                  <span className="font-mono text-[10.5px] text-[var(--color-fg-3)] truncate tracking-[0.02em]">
                    {user?.email || '—'}
                  </span>
                </span>
                <ChevronsUpDown
                  className="ml-auto w-3.5 h-3.5 text-[var(--color-fg-3)] shrink-0"
                  strokeWidth={1.5}
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              className="min-w-[200px]"
            >
              <DropdownMenuLabel>
                {isAnonymous ? '本地模式 · 无需登录' : '账户'}
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() =>
                  setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
                }
              >
                {resolvedTheme === 'dark' ? (
                  <Sun
                    className="w-3.5 h-3.5 text-[var(--color-fg-2)]"
                    strokeWidth={1.5}
                  />
                ) : (
                  <Moon
                    className="w-3.5 h-3.5 text-[var(--color-fg-2)]"
                    strokeWidth={1.5}
                  />
                )}
                {resolvedTheme === 'dark' ? '浅色主题' : '深色主题'}
              </DropdownMenuItem>
              {!isAnonymous && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={handleLogout}>
                    <LogOut className="w-3.5 h-3.5" strokeWidth={1.5} />
                    退出登录
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}

function NavGroup({
  label,
  items,
  pathname,
  onItemClick,
  className,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
  onItemClick: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <div className="font-mono text-[11px] text-[var(--color-fg-3)] uppercase tracking-[0.1em] px-2 mb-1.5">
        {label}
      </div>
      {items.map((item) => {
        const Icon = item.icon;
        const active =
          pathname === item.href ||
          (item.href !== '/' && pathname.startsWith(item.href));
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onItemClick}
            className={cn(
              'flex items-center gap-2.5 px-2 py-[7px] rounded-[6px] text-[13px] ' +
                'text-[var(--color-fg)] transition-colors duration-100',
              active
                ? 'bg-[var(--color-bg)] font-medium border border-[var(--color-border)]'
                : 'font-normal hover:bg-[var(--color-bg)]',
            )}
          >
            <Icon
              className="w-4 h-4 text-[var(--color-fg-2)]"
              strokeWidth={1.5}
            />
            <span>{item.label}</span>
            {item.badge && (
              <span className="ml-auto font-mono text-[10px] text-[var(--color-fg-3)] tracking-[0.04em]">
                {item.badge}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
