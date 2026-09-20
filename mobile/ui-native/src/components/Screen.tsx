import { View, type ViewProps } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { cn } from '../lib/cn.js';

export interface ScreenProps extends ViewProps {
  /** Which insets to pad. Defaults to all but bottom (tab bars usually own the bottom). */
  edges?: readonly Edge[];
  /** Drop the default screen padding (e.g. for full-bleed lists). */
  padded?: boolean;
  className?: string;
}

/**
 * Safe-area screen wrapper. Every route's root element — fills the screen, paints the
 * themed background, and keeps content clear of notches/home indicators. Background uses the
 * semantic `bg-bg` token so it tracks the active portal theme.
 */
export function Screen({
  edges = ['top', 'left', 'right'],
  padded = true,
  className,
  children,
  ...props
}: ScreenProps) {
  return (
    <SafeAreaView edges={edges} className="flex-1 bg-bg">
      <View className={cn('flex-1', padded ? 'px-4 py-4' : null, className)} {...props}>
        {children}
      </View>
    </SafeAreaView>
  );
}
