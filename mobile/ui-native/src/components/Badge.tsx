import * as React from 'react';
import { View, type ViewProps } from 'react-native';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';
import { Text } from './Text.js';

const badgeVariants = cva('flex-row items-center gap-1 self-start rounded-sm border px-2 py-0.5', {
  variants: {
    variant: {
      neutral: 'border-border bg-surface-muted',
      accent: 'border-transparent bg-accent',
      success: 'border-transparent bg-success',
      warning: 'border-transparent bg-warning',
      danger: 'border-transparent bg-danger',
      /**
       * Trust badge — the only consumer of the generic `--color-trust` token. `trust` here
       * is a degree-of-confidence accent, NOT a domain concept; this component carries no
       * domain types and stays valid in any project.
       */
      trust: 'border-trust/40 bg-trust/10',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

const badgeTextVariants = cva('text-xs font-medium font-sans', {
  variants: {
    variant: {
      neutral: 'text-text',
      accent: 'text-accent-text',
      success: 'text-accent-text',
      warning: 'text-accent-text',
      danger: 'text-accent-text',
      trust: 'text-trust',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

export interface BadgeProps extends ViewProps, VariantProps<typeof badgeVariants> {
  children: React.ReactNode;
  className?: string;
}

export function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <View className={cn(badgeVariants({ variant }), className)} {...props}>
      {typeof children === 'string' ? (
        <Text className={cn(badgeTextVariants({ variant }))}>{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}

export { badgeVariants };
