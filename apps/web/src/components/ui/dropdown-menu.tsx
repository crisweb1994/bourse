'use client';

import * as RMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Circle } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * DropdownMenu — Radix-backed menu, styled to editorial tokens.
 * Use Trigger / Content / Item / Label / Separator from this module
 * (re-exports of Radix primitives with our classNames).
 */
export const DropdownMenu = RMenu.Root;
export const DropdownMenuTrigger = RMenu.Trigger;
export const DropdownMenuPortal = RMenu.Portal;
export const DropdownMenuGroup = RMenu.Group;
export const DropdownMenuRadioGroup = RMenu.RadioGroup;
export const DropdownMenuSub = RMenu.Sub;

export const DropdownMenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RMenu.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <RMenu.Portal>
    <RMenu.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[180px] overflow-hidden rounded-[var(--radius-card)] ' +
          'border border-[var(--color-border)] bg-[var(--color-bg)] p-1 ' +
          'text-[var(--color-fg)]',
        className,
      )}
      {...props}
    />
  </RMenu.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RMenu.Item> & {
    danger?: boolean;
    inset?: boolean;
  }
>(({ className, danger, inset, ...props }, ref) => (
  <RMenu.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] ' +
        'px-2 py-1.5 text-[13px] outline-none transition-colors ' +
        'data-[highlighted]:bg-[var(--color-surface-hover)] ' +
        'data-[disabled]:opacity-50 data-[disabled]:pointer-events-none',
      inset && 'pl-6',
      danger && 'text-[var(--color-danger)] data-[highlighted]:bg-[var(--color-danger-soft)]',
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuCheckboxItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RMenu.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <RMenu.CheckboxItem
    ref={ref}
    className={cn(
      'relative flex cursor-pointer items-center gap-2 rounded-[6px] py-1.5 pl-7 pr-2 text-[13px] outline-none ' +
        'data-[highlighted]:bg-[var(--color-surface-hover)] data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 inline-flex h-3.5 w-3.5 items-center justify-center">
      <RMenu.ItemIndicator>
        <Check className="w-3 h-3" strokeWidth={1.5} />
      </RMenu.ItemIndicator>
    </span>
    {children}
  </RMenu.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

export const DropdownMenuRadioItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RMenu.RadioItem>
>(({ className, children, ...props }, ref) => (
  <RMenu.RadioItem
    ref={ref}
    className={cn(
      'relative flex cursor-pointer items-center gap-2 rounded-[6px] py-1.5 pl-7 pr-2 text-[13px] outline-none ' +
        'data-[highlighted]:bg-[var(--color-surface-hover)] data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 inline-flex h-3.5 w-3.5 items-center justify-center">
      <RMenu.ItemIndicator>
        <Circle className="w-1.5 h-1.5 fill-current" strokeWidth={1.5} />
      </RMenu.ItemIndicator>
    </span>
    {children}
  </RMenu.RadioItem>
));
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

export const DropdownMenuLabel = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RMenu.Label>
>(({ className, ...props }, ref) => (
  <RMenu.Label
    ref={ref}
    className={cn(
      'px-2 pt-2 pb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--color-fg-3)]',
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

export const DropdownMenuSeparator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RMenu.Separator>
>(({ className, ...props }, ref) => (
  <RMenu.Separator
    ref={ref}
    className={cn('my-1 h-px bg-[var(--color-border-soft)]', className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export function DropdownMenuShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'ml-auto font-mono text-[10.5px] text-[var(--color-fg-3)] tracking-[0.04em]',
        className,
      )}
      {...props}
    />
  );
}

export const DropdownMenuSubTrigger = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RMenu.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <RMenu.SubTrigger
    ref={ref}
    className={cn(
      'flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] outline-none ' +
        'data-[highlighted]:bg-[var(--color-surface-hover)]',
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto w-3.5 h-3.5 text-[var(--color-fg-3)]" strokeWidth={1.5} />
  </RMenu.SubTrigger>
));
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger';

export const DropdownMenuSubContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RMenu.SubContent>
>(({ className, ...props }, ref) => (
  <RMenu.SubContent
    ref={ref}
    className={cn(
      'z-50 min-w-[180px] overflow-hidden rounded-[var(--radius-card)] ' +
        'border border-[var(--color-border)] bg-[var(--color-bg)] p-1',
      className,
    )}
    {...props}
  />
));
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent';
