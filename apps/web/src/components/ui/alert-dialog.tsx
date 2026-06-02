'use client';

import * as RDialog from '@radix-ui/react-alert-dialog';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

/**
 * AlertDialog — Radix-backed confirmation dialog with editorial tokens.
 * Used to replace `window.confirm()` calls.
 *
 * Most consumers should use the `useConfirm()` hook below rather than
 * composing primitives by hand.
 */

export const AlertDialog = RDialog.Root;
export const AlertDialogTrigger = RDialog.Trigger;
export const AlertDialogPortal = RDialog.Portal;

export function AlertDialogContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-black/40 ' +
            'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        )}
      />
      <RDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[calc(100vw-32px)] ' +
            '-translate-x-1/2 -translate-y-1/2 ' +
            'rounded-[var(--radius-card)] border border-[var(--color-border)] ' +
            'bg-[var(--color-bg)] p-6 ' +
            'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ' +
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className,
        )}
      >
        {children}
      </RDialog.Content>
    </RDialog.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof RDialog.Title>) {
  return (
    <RDialog.Title
      className={cn(
        'm-0 text-[16px] font-semibold tracking-[-0.01em]',
        className,
      )}
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof RDialog.Description>) {
  return (
    <RDialog.Description
      className={cn(
        'mt-2 m-0 text-[13px] text-[var(--color-fg-2)] leading-[1.6]',
        className,
      )}
      {...props}
    />
  );
}

export const AlertDialogAction = RDialog.Action;
export const AlertDialogCancel = RDialog.Cancel;

type ComponentProps<T> = T extends React.ComponentType<infer P> ? P : never;

// ============================================================
// useConfirm — programmatic confirm() replacement
// ============================================================

interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback(
    (next: ConfirmOptions): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        setOpts(next);
        setOpen(true);
      });
    },
    [],
  );

  const finish = (v: boolean) => {
    setOpen(false);
    resolverRef.current?.(v);
    resolverRef.current = null;
  };

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o) finish(false);
        }}
      >
        {opts && (
          <AlertDialogContent>
            <AlertDialogTitle>{opts.title}</AlertDialogTitle>
            {opts.description && (
              <AlertDialogDescription>
                {opts.description}
              </AlertDialogDescription>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialogCancel asChild>
                <Button onClick={() => finish(false)}>
                  {opts.cancelText ?? '取消'}
                </Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button
                  variant={opts.danger ? 'danger' : 'primary'}
                  onClick={() => finish(true)}
                >
                  {opts.confirmText ?? '确定'}
                </Button>
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>');
  }
  return ctx.confirm;
}
