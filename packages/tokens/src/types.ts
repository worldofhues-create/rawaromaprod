/**
 * Semantic token contract. Components in `ui` / `ui-native` reference ONLY these semantic
 * names (e.g. `--surface`, `--accent`) — never raw colors. A new project / portal = a new
 * token set, zero component changes. (Token-discipline lint enforces this downstream.)
 */
export interface SemanticTokens {
  /** Color tokens — CSS color strings (hex / oklch / rgb). */
  color: {
    bg: string;
    surface: string;
    surfaceMuted: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    accentText: string;
    /** Trust-degree accent (the product's signature) — used by trust badges. */
    trust: string;
    success: string;
    warning: string;
    danger: string;
  };
  radius: { sm: string; md: string; lg: string };
  /** UI density — drives default paddings/heights. */
  density: 'comfortable' | 'compact';
  font: { sans: string; mono: string };
}

export type Portal =
  | 'buyer'
  | 'owner'
  | 'builder'
  | 'inspector'
  | 'ops'
  | 'finance'
  | 'admin';
