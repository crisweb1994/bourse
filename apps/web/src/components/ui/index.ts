/**
 * Editorial-developer-console UI primitives.
 *
 * Re-exported here so consumers can do
 *   `import { Button, Pill, SectionTag } from '@/components/ui'`.
 *
 * Hard rules (echoed from docs/mockups/ui-redesign-2026-05-16.html):
 *   - never `shadow-*` / `bg-gradient-*` / `backdrop-blur-*`
 *   - never emoji icons (use lucide-react)
 *   - palette = black + white + gray + emerald; reserve blue/warn/danger
 *     for tiny status pills only
 */
export { Button, type ButtonProps } from './button';
export { Card, CardHead, CardBody } from './card';
export { Input, InputShell } from './input';
export { Pill, type PillProps } from './pill';
export { SectionTag } from './section-tag';
export { Table, THead, TBody, TFoot, Sym } from './table';
export { Kbd } from './kbd';
export { PageHeader, SectionHead } from './page-header';
export {
  Select,
  SelectOption,
  SelectGroup,
  SelectSeparator,
} from './select';
export { Switch, SwitchRow } from './switch';
export { Dialog } from './popover';
export type { DialogProps } from './popover';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuRadioGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuGroup,
  DropdownMenuPortal,
} from './dropdown-menu';
export { Toaster, toast } from './toaster';
export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
  ConfirmProvider,
  useConfirm,
} from './alert-dialog';
