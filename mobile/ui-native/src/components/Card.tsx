import * as React from 'react';
import { View, type ViewProps } from 'react-native';
import { cn } from '../lib/cn.js';
import { Text } from './Text.js';

export interface CardProps extends ViewProps {
  className?: string;
}

/** Surface container — the base of every grouped block on a screen. */
export function Card({ className, ...props }: CardProps) {
  return (
    <View
      className={cn('rounded-lg border border-border bg-surface p-4', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: CardProps) {
  return <View className={cn('mb-3 gap-1', className)} {...props} />;
}

export function CardTitle({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Text variant="title" className={className}>
      {children}
    </Text>
  );
}

export function CardDescription({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Text variant="muted" className={className}>
      {children}
    </Text>
  );
}

export function CardContent({ className, ...props }: CardProps) {
  return <View className={cn('gap-3', className)} {...props} />;
}

export function CardFooter({ className, ...props }: CardProps) {
  return <View className={cn('mt-4 flex-row items-center gap-2', className)} {...props} />;
}
