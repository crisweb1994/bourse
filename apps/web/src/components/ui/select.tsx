'use client';

import * as RSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Select — Radix-backed accessible dropdown with our editorial token styling.
 *
 * Use as:
 *   <Select value={v} onValueChange={setV} placeholder="选择…">
 *     <SelectOption value="A">Option A</SelectOption>
 *     <SelectGroup label="Group">
 *       <SelectOption value="B">Option B</SelectOption>
 *     </SelectGroup>
 *   </Select>
 *
 * Trigger height matches InputShell (h-10). Mono font by default (matches
 * the rest of the form-control language).
 */

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  placeholder?: ReactNode;
  disabled?: boolean;
  /** Class on the trigger. */
  className?: string;
  /** Sans-serif trigger label (defaults to mono). */
  sans?: boolean;
  children: ReactNode;
  ariaLabel?: string;
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled,
  className,
  sans,
  children,
  ariaLabel,
}: SelectProps) {
  return (
    <RSelect.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <RSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          'flex h-10 items-center justify-between gap-2 rounded-[var(--radius-btn)] ' +
            'border border-[var(--color-border)] bg-[var(--color-bg)] ' +
            'px-3 text-[13px] text-[var(--color-fg)] outline-none ' +
            'transition-colors duration-100 ' +
            'data-[state=open]:border-[var(--color-fg)] ' +
            'hover:bg-[var(--color-surface-hover)] ' +
            'disabled:opacity-50 disabled:pointer-events-none ' +
            'data-[placeholder]:text-[var(--color-fg-3)]',
          sans ? 'font-sans' : 'font-mono',
          className,
        )}
      >
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon className="text-[var(--color-fg-3)] shrink-0">
          <ChevronDown className="w-3.5 h-3.5" strokeWidth={1.5} />
        </RSelect.Icon>
      </RSelect.Trigger>

      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={6}
          className={cn(
            'z-50 min-w-[var(--radix-select-trigger-width)] max-h-[min(360px,var(--radix-select-content-available-height))] ' +
              'overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] ' +
              'bg-[var(--color-bg)] text-[var(--color-fg)] ' +
              'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        >
          <RSelect.Viewport className="p-1">{children}</RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export const SelectOption = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RSelect.Item>
>(({ className, children, ...props }, ref) => (
  <RSelect.Item
    ref={ref}
    {...props}
    className={cn(
      'relative flex w-full items-center gap-2 rounded-[6px] py-1.5 pl-2 pr-7 ' +
        'text-[13px] text-[var(--color-fg)] outline-none cursor-pointer select-none ' +
        'data-[highlighted]:bg-[var(--color-surface-hover)] ' +
        'data-[disabled]:opacity-50 data-[disabled]:pointer-events-none',
      className,
    )}
  >
    <RSelect.ItemText>{children}</RSelect.ItemText>
    <RSelect.ItemIndicator className="absolute right-2 inline-flex items-center text-[var(--color-fg)]">
      <Check className="w-3.5 h-3.5" strokeWidth={1.5} />
    </RSelect.ItemIndicator>
  </RSelect.Item>
));
SelectOption.displayName = 'SelectOption';

export function SelectGroup({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <RSelect.Group>
      <RSelect.Label className="px-2 pt-2 pb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--color-fg-3)]">
        {label}
      </RSelect.Label>
      {children}
    </RSelect.Group>
  );
}

export function SelectSeparator({ className }: { className?: string }) {
  return (
    <RSelect.Separator
      className={cn('my-1 h-px bg-[var(--color-border-soft)]', className)}
    />
  );
}
