import * as React from 'react';
import { View } from 'react-native';
import type { Portal } from '@core/tokens';
import { portalThemeVars } from './tokens-to-vars.js';

interface ThemeContextValue {
  portal: Portal;
  /** Swap the active portal at runtime (e.g. after reading the role claim at login). */
  setPortal: (portal: Portal) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /** The portal whose tokens theme the subtree. Set from the role claim at login. */
  portal: Portal;
  children: React.ReactNode;
}

/**
 * Applies a portal's semantic tokens as NativeWind CSS variables to its subtree, then makes
 * the active portal available via context. Every @core/ui-native component authors with
 * semantic classes (`bg-surface`, `text-accent`), so they all re-skin when `portal` changes
 * — the mobile mirror of web's `<html data-portal="…">`.
 *
 * The root `View` carries the `vars()` style and fills the screen so the theme cascades to
 * everything below it. Wrap your app once (typically just inside the safe-area / navigation
 * providers).
 */
export function ThemeProvider({ portal, children }: ThemeProviderProps) {
  const [active, setActive] = React.useState<Portal>(portal);

  // Keep internal state in sync if the host drives `portal` as a controlled prop.
  React.useEffect(() => setActive(portal), [portal]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ portal: active, setPortal: setActive }),
    [active],
  );

  return (
    <ThemeContext.Provider value={value}>
      <View style={portalThemeVars(active)} className="flex-1 bg-bg">
        {children}
      </View>
    </ThemeContext.Provider>
  );
}

/** Read/!switch the active portal theme from any descendant of <ThemeProvider>. */
export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a <ThemeProvider portal={…}>');
  }
  return ctx;
}
