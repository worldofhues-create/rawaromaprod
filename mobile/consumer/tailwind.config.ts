import type { Config } from 'tailwindcss';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { uiNativePreset } from '@core/ui-native/tailwind-preset';

/**
 * NativeWind (Tailwind v3) config. Two presets:
 *   1. `nativewind/preset` — RN-compatible Tailwind core.
 *   2. `uiNativePreset` — maps @core/tokens semantic vars → theme keys (bg-surface, …).
 *
 * `content` must include this app's screens AND the @core/ui-native source so the kit's
 * utility classes are not tree-shaken away.
 */
const config: Config = {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  presets: [require('nativewind/preset'), uiNativePreset],
  content: [
    './app/**/*.{ts,tsx}',
    '../ui-native/src/**/*.{ts,tsx}',
  ],
  theme: { extend: {} },
  plugins: [],
};

export default config;
