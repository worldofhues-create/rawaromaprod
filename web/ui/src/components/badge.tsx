import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { ShieldCheck } from 'lucide-react';
import { cn } from '../lib/cn.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-surface-muted text-text',
        accent: 'border-transparent bg-accent text-accent-text',
        success: 'border-transparent bg-success text-accent-text',
        warning: 'border-transparent bg-warning text-accent-text',
        danger: 'border-transparent bg-danger text-accent-text',
        /**
         * Trust badge — the only consumer of the generic `--color-trust` token.
         * `trust` here is a degree-of-confidence accent, NOT a domain concept; this
         * component carries no domain types and stays valid in any project.
         */
        trust: 'border-trust/40 bg-trust/10 text-trust',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Show the leading shield glyph (defaults on for the `trust` variant). */
  icon?: boolean;
}

export function Badge({ className, variant, icon, children, ...props }: BadgeProps) {
  const showIcon = icon ?? variant === 'trust';
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {showIcon ? <ShieldCheck aria-hidden /> : null}
      {children}
    </span>
  );
}

export { badgeVariants };
