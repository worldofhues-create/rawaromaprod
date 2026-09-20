import { PORTAL_TOKENS, tokensToCssVars, type Portal } from '@core/tokens';
import { vars } from 'nativewind';

/**
 * Build the NativeWind style object that injects a portal's semantic tokens as CSS
 * variables onto a view. This is the mobile equivalent of web's
 * `:root[data-portal="x"] { --color-…: … }` block — but applied imperatively via
 * NativeWind's `vars()` instead of a stylesheet + DOM attribute.
 *
 * We reuse @core/tokens' own `tokensToCssVars` so web and mobile derive the EXACT same
 * variable set from the EXACT same source — rebranding stays a single-file edit in
 * @core/tokens.
 *
 * `vars()` returns an opaque NativeWind style; type it through ReturnType so callers stay
 * decoupled from NativeWind's internal style typing.
 */
export type ThemeVars = ReturnType<typeof vars>;

export function portalThemeVars(portal: Portal): ThemeVars {
  return vars(tokensToCssVars(PORTAL_TOKENS[portal]));
}

/** All portals pre-computed — handy for memoized providers / storybook-style previews. */
export const PORTAL_THEME_VARS: Record<Portal, ThemeVars> = (
  Object.keys(PORTAL_TOKENS) as Portal[]
).reduce(
  (acc, p) => {
    acc[p] = portalThemeVars(p);
    return acc;
  },
  {} as Record<Portal, ThemeVars>,
);
