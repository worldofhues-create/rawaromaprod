// @core/ui — Tier-1 generic, DOMAIN-FREE component kit.
// Components reference ONLY semantic tokens (via the Tailwind preset). No domain types.

export { cn } from './lib/cn.js';

export { Button, buttonVariants, type ButtonProps } from './components/button.js';
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './components/card.js';
export { Input, type InputProps } from './components/input.js';
export { Label } from './components/label.js';
export { Badge, badgeVariants, type BadgeProps } from './components/badge.js';
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './components/dialog.js';
export {
  DataTable,
  type ColumnDef,
  type DataTableProps,
  type SortState,
  type SortDirection,
} from './components/data-table.js';

export { uiPreset } from './tailwind-preset.js';
