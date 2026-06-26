import * as React from 'react';
import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const textVariants = cva('font-sans', {
  variants: {
    variant: {
      body: 'text-base text-text',
      muted: 'text-sm text-text-muted',
      heading: 'text-2xl font-semibold text-text',
      title: 'text-lg font-semibold text-text',
      caption: 'text-xs text-text-muted',
      danger: 'text-sm text-danger',
    },
  },
  defaultVariants: { variant: 'body' },
});

export interface TextProps extends RNTextProps, VariantProps<typeof textVariants> {
  className?: string;
}

/** Semantic typography primitive. All app text goes through this so it themes consistently. */
export const Text = React.forwardRef<RNText, TextProps>(
  ({ className, variant, ...props }, ref) => (
    <RNText ref={ref} className={cn(textVariants({ variant }), className)} {...props} />
  ),
);
Text.displayName = 'Text';

export { textVariants };
