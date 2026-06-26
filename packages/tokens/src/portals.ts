import type { Portal, SemanticTokens } from './types.js';

const SANS = '"Inter", system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';

/** Base (light) — portals override only what differs, keeping them in sync. */
const base: SemanticTokens = {
  color: {
    bg: '#fbf8f2',          // warm ivory — perfume-house light surface
    surface: '#f4efe4',
    surfaceMuted: '#e9e1d1',
    border: '#ddd2bd',
    text: '#1c1812',
    textMuted: '#6f6553',
    accent: '#b08919',       // RAW AROMACHEM antique gold
    accentText: '#1a1306',
    trust: '#0e7c6b',        // deep aromatic teal
    success: '#16a34a',
    warning: '#c2820a',
    danger: '#c0392b',
  },
  radius: { sm: '6px', md: '10px', lg: '16px' },
  density: 'comfortable',
  font: { sans: SANS, mono: MONO },
};

const merge = (o: Partial<SemanticTokens['color']>, rest?: Partial<SemanticTokens>): SemanticTokens => ({
  ...base,
  ...rest,
  color: { ...base.color, ...o },
});

/**
 * The 7 portal themes — distinct identity per role, same semantic contract.
 * Buyer warm/light · Owner indigo · Builder slate data-dense · Inspector high-contrast dark
 * · Ops dark console · Finance deep green · Admin charcoal/red (danger-aware).
 */
export const PORTAL_TOKENS: Record<Portal, SemanticTokens> = {
  buyer: merge({ accent: '#e2630f', bg: '#fffdf9', surface: '#fdf6ec', trust: '#0ea5a3' }),
  owner: merge(
    { bg: '#0e0b07', surface: '#17120b', surfaceMuted: '#211a10', border: '#33291a', text: '#f4eede', textMuted: '#a8997d', accent: '#caa53e', accentText: '#1a1306', trust: '#2bb39a' },
  ),
  builder: merge({ accent: '#475569', surface: '#f1f5f9' }, { density: 'compact' }),
  inspector: merge(
    { bg: '#0b0f14', surface: '#141a21', surfaceMuted: '#1d2530', border: '#2a3340', text: '#f2f5f8', textMuted: '#9aa6b2', accent: '#22d3ee', accentText: '#04141a', trust: '#34d399' },
    { density: 'compact' },
  ),
  ops: merge({ bg: '#0d1117', surface: '#161b22', surfaceMuted: '#21262d', border: '#30363d', text: '#e6edf3', textMuted: '#8b949e', accent: '#388bfd', accentText: '#ffffff', trust: '#2dd4bf' }),
  finance: merge({ accent: '#047857', surface: '#f0fdf4', trust: '#0ea5a3' }),
  admin: merge({ bg: '#101013', surface: '#191920', surfaceMuted: '#23232c', border: '#2f2f3a', text: '#ededf2', textMuted: '#9a9aa6', accent: '#e5484d', accentText: '#ffffff' }),
};
