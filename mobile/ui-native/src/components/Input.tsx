import * as React from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { cn } from '../lib/cn.js';
import { Text } from './Text.js';

export interface InputProps extends TextInputProps {
  /** Optional field label rendered above the input. */
  label?: string;
  /** Validation error message rendered below the input (also flags invalid styling). */
  error?: string;
  className?: string;
  containerClassName?: string;
}

/**
 * Themed text field. Uses semantic tokens for every color — including the placeholder,
 * resolved from the active `--color-text-muted` var via NativeWind's resolver.
 */
export const Input = React.forwardRef<TextInput, InputProps>(
  ({ label, error, className, containerClassName, ...props }, ref) => (
    <View className={cn('gap-1.5', containerClassName)}>
      {label ? (
        <Text variant="muted" className="text-text">
          {label}
        </Text>
      ) : null}
      <TextInput
        ref={ref}
        placeholderClassName="text-text-muted"
        className={cn(
          'h-11 rounded-md border border-border bg-bg px-3 text-base text-text',
          error ? 'border-danger' : null,
          className,
        )}
        accessibilityState={{ disabled: props.editable === false }}
        {...props}
      />
      {error ? <Text variant="danger">{error}</Text> : null}
    </View>
  ),
);
Input.displayName = 'Input';
