'use client';

import * as RSwitch from '@radix-ui/react-switch';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Switch — Radix-backed toggle, styled to our editorial token language.
 * Rail is fg color when on, fg-4 when off; thumb is bg color.
 */
export const Switch = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof RSwitch.Root>
>(({ className, ...props }, ref) => (
  <RSwitch.Root
    ref={ref}
    {...props}
    className={cn(
      'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full ' +
        'transition-colors duration-150 outline-none ' +
        'data-[state=unchecked]:bg-[var(--color-fg-4)] ' +
        'data-[state=checked]:bg-[var(--color-fg)] ' +
        'disabled:opacity-50 disabled:cursor-not-allowed',
      className,
    )}
  >
    <RSwitch.Thumb
      className={cn(
        'pointer-events-none block h-4 w-4 rounded-full bg-[var(--color-bg)] ' +
          'shadow-[0_1px_2px_rgba(0,0,0,0.15)] transition-transform duration-150 ' +
          'translate-x-0.5 data-[state=checked]:translate-x-[18px]',
      )}
    />
  </RSwitch.Root>
));
Switch.displayName = 'Switch';

/**
 * SwitchRow — label + description + Switch in a bordered row layout
 * (used in settings capability sections).
 */
export function SwitchRow({
  label,
  desc,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2.5 cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {desc && (
          <div className="mt-0.5 text-[11.5px] text-[var(--color-fg-2)] leading-[1.55]">
            {desc}
          </div>
        )}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </label>
  );
}
