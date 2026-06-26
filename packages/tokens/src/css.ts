import type { Portal, SemanticTokens } from './types.js';
import { PORTAL_TOKENS } from './portals.js';

/** Flattens a token set to CSS custom properties (`--surface`, `--accent`, …). */
export function tokensToCssVars(t: SemanticTokens): Record<string, string> {
  const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.color)) vars[`--color-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(t.radius)) vars[`--radius-${k}`] = v;
  vars['--font-sans'] = t.font.sans;
  vars['--font-mono'] = t.font.mono;
  vars['--density'] = t.density;
  return vars;
}

/** Emits a `:root[data-portal="x"] { … }` block per portal — drop into a global stylesheet. */
export function portalThemeCss(portal: Portal): string {
  const vars = tokensToCssVars(PORTAL_TOKENS[portal]);
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `:root[data-portal="${portal}"] {\n${body}\n}`;
}

export const allPortalThemeCss = (): string =>
  (Object.keys(PORTAL_TOKENS) as Portal[]).map(portalThemeCss).join('\n\n');
