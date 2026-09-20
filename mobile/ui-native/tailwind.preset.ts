import type { Config } from 'tailwindcss';

/**
 * NativeWind (Tailwind v3) preset for @core/ui-native.
 *
 * Maps the SAME semantic tokens that @core/tokens emits for web (`--color-surface`,
 * `--color-accent`, `--color-trust`, `--radius-md`, …) onto Tailwind theme keys, so RN
 * components author with semantic utilities only — `bg-surface`, `text-accent`,
 * `border-border`, `rounded-md` — never raw palette classes like `bg-blue-500`.
 *
 * Because every value is a `var(--…)`, the actual color is decided at runtime by the
 * active portal theme. On mobile there is no DOM `data-portal` attribute; instead
 * `<ThemeProvider portal="…">` (see src/theme/ThemeProvider.tsx) sets these CSS vars via
 * NativeWind's `vars()` on the root view. Switching portals (rebranding) is a pure
 * variable swap — zero component edits, identical contract to web.
 *
 * IMPORTANT version pairing: NativeWind 4 runs on TAILWIND 3 (not 4). This preset must be
 * authored against `tailwindcss@^3.4.x`.
 *
 * Usage (app side, tailwind.config.ts):
 *   import { uiNativePreset } from '@core/ui-native/tailwind-preset';
 *   export default {
 *     presets: [require('nativewind/preset'), uiNativePreset],
 *     content: ['./app/**\/*.{ts,tsx}', '../../mobile/ui-native/src/**\/*.{ts,tsx}'],
 *   };
 */
export const uiNativePreset = {
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        'surface-muted': 'var(--color-surface-muted)',
        border: 'var(--color-border)',
        text: 'var(--color-text)',
        'text-muted': 'var(--color-text-muted)',
        accent: 'var(--color-accent)',
        'accent-text': 'var(--color-accent-text)',
        trust: 'var(--color-trust)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-danger)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
    },
  },
} satisfies Partial<Config>;

export default uiNativePreset;
