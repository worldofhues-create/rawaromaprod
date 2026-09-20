import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text as RNText,
  type PressableProps,
} from 'react-native';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const buttonVariants = cva(
  'flex-row items-center justify-center gap-2 rounded-md active:opacity-90 disabled:opacity-50',
  {
    variants: {
      variant: {
        solid: 'bg-accent',
        outline: 'border border-border bg-transparent',
        ghost: 'bg-transparent',
        subtle: 'bg-surface-muted',
        danger: 'bg-danger',
      },
      size: {
        sm: 'h-9 px-3',
        md: 'h-11 px-4',
        lg: 'h-12 px-6',
      },
    },
    defaultVariants: { variant: 'solid', size: 'md' },
  },
);

const buttonLabelVariants = cva('text-sm font-medium font-sans', {
  variants: {
    variant: {
      solid: 'text-accent-text',
      outline: 'text-text',
      ghost: 'text-text',
      subtle: 'text-text',
      danger: 'text-accent-text',
    },
  },
  defaultVariants: { variant: 'solid' },
});

export interface ButtonProps
  extends Omit<PressableProps, 'children'>,
    VariantProps<typeof buttonVariants> {
  /** Button label text. */
  children: React.ReactNode;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  className?: string;
  /** Extra classes for the label text. */
  textClassName?: string;
}

export const Button = React.forwardRef<React.ElementRef<typeof Pressable>, ButtonProps>(
  ({ className, textClassName, variant, size, loading, disabled, children, ...props }, ref) => {
    const isDisabled = disabled || loading;
    return (
      <Pressable
        ref={ref}
        accessibilityRole="button"
        accessibilityState={{ disabled: Boolean(isDisabled), busy: Boolean(loading) }}
        disabled={isDisabled}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {loading ? <ActivityIndicator size="small" /> : null}
        {typeof children === 'string' ? (
          <RNText className={cn(buttonLabelVariants({ variant }), textClassName)}>
            {children}
          </RNText>
        ) : (
          children
        )}
      </Pressable>
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
