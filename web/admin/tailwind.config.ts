import type { Config } from 'tailwindcss';
import { uiPreset } from '@core/ui/tailwind-preset';

/**
 * Tailwind v4. The semantic theme (colors → var(--color-*), radius, fonts) comes entirely
 * from @core/ui's preset, so this app authors with semantic utilities only. The `content`
 * globs MUST include the workspace UI + feature packages or their classes get purged.
 */
const config: Config = {
  presets: [uiPreset],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    // Scan source of consumed workspace packages so their utilities survive purge.
    '../ui/src/**/*.{ts,tsx}',
    '../feature-auth/src/**/*.{ts,tsx}',
  ],
};

export default config;
