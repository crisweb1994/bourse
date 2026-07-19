'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, Cpu, Search, User, type LucideIcon } from 'lucide-react';
import { useConfirm } from '@/components/ui';
import { cn } from '@/lib/utils';

interface SettingsNavItem {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

const ITEMS: SettingsNavItem[] = [
  {
    href: '/settings/providers',
    label: 'AI Provider',
    description: '模型与凭证',
    icon: Cpu,
  },
  {
    href: '/settings/web-search',
    label: '联网搜索',
    description: '搜索适配器',
    icon: Search,
  },
  {
    href: '/settings/digest',
    label: '行情简报',
    description: '市场与投递',
    icon: Bell,
  },
  {
    href: '/settings/profile',
    label: '账户',
    description: '个人偏好',
    icon: User,
  },
];

export function SettingsNav() {
  const pathname = usePathname();
  const router = useRouter();
  const confirm = useConfirm();

  const navigate = async (
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    if (pathname === href || document.documentElement.dataset.settingsDirty !== 'true') {
      return;
    }
    event.preventDefault();
    const leave = await confirm({
      title: '放弃未保存的更改？',
      description: '离开后，本页尚未保存的 Provider 配置将丢失。',
      confirmText: '放弃更改',
      cancelText: '继续编辑',
      danger: true,
    });
    if (!leave) return;
    delete document.documentElement.dataset.settingsDirty;
    router.push(href);
  };

  return (
    <nav aria-label="设置分类" className="min-w-0">
      <div className="flex gap-1 overflow-x-auto pb-2 lg:hidden">
        {ITEMS.map((item) => (
          <SettingsLink
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
            compact
            onClick={navigate}
          />
        ))}
      </div>

      <div className="hidden lg:flex lg:flex-col lg:gap-1">
        {ITEMS.map((item) => (
          <SettingsLink
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
            onClick={navigate}
          />
        ))}
      </div>
    </nav>
  );
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SettingsLink({
  item,
  active,
  compact,
  onClick,
}: {
  item: SettingsNavItem;
  active: boolean;
  compact?: boolean;
  onClick: (
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => onClick(event, item.href)}
      className={cn(
        'flex shrink-0 items-center rounded-[var(--radius-btn)] border transition-colors',
        compact ? 'h-10 gap-2 px-3 text-[13px]' : 'gap-3 px-3 py-2.5',
        active
          ? 'border-[var(--color-border)] bg-[var(--color-bg-elev)] text-[var(--color-fg)]'
          : 'border-transparent text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
      <span className="min-w-0">
        <span className="block whitespace-nowrap text-[13px] font-medium">
          {item.label}
        </span>
        {!compact && (
          <span className="mt-0.5 block text-[11px] text-[var(--color-fg-3)]">
            {item.description}
          </span>
        )}
      </span>
    </Link>
  );
}
