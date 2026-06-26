// @core/ui-native — Tier-1 generic, domain-free RN component kit (NativeWind 4).
// Themed only through the semantic tokens from @core/tokens via <ThemeProvider>.

// Theming
export { ThemeProvider, useTheme, type ThemeProviderProps } from './theme/ThemeProvider.js';
export {
  portalThemeVars,
  PORTAL_THEME_VARS,
  type ThemeVars,
} from './theme/tokens-to-vars.js';

// Class-merge helper
export { cn } from './lib/cn.js';

// Components
export { Text, textVariants, type TextProps } from './components/Text.js';
export { Button, buttonVariants, type ButtonProps } from './components/Button.js';
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  type CardProps,
} from './components/Card.js';
export { Input, type InputProps } from './components/Input.js';
export { Badge, badgeVariants, type BadgeProps } from './components/Badge.js';
export { Screen, type ScreenProps } from './components/Screen.js';
