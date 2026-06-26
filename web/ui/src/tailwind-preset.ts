import type { Config } from 'tailwindcss';

/**
 * Tailwind v4 preset for @core/ui.
 *
 * Maps the SEMANTIC CSS variables emitted by @core/tokens (`--color-surface`,
 * `--color-accent`, `--color-trust`, `--radius-md`, …) onto Tailwind theme keys, so
 * components author with semantic utilities only — `bg-surface`, `text-accent`,
 * `border-border`, `rounded-md` — never raw palette classes like `bg-blue-500`.
 *
 * Because every value is a `var(--…)`, the actual color is decided at runtime by the
 * `data-portal="…"` attribute on <html> (see styles/theme.css). Switching portals (and
 * therefore rebranding) is a pure CSS-variable swap — zero component edits.
 *
 * Token-discipline lint (see web/README.md) forbids raw palette utilities in this tier,
 * keeping the kit themeable across all 7 portals and any future white-label.
 *
 * Usage (Tailwind v4, app side):
 *   // tailwind.config.ts
 *   import { uiPreset } from '@core/ui/tailwind-preset';
 *   export default { presets: [uiPreset], content: [...] };
 */
export const uiPreset = {
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

export default uiPreset;
