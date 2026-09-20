import { create } from 'zustand';
import type { AuthUser, TokenPair } from '../api/endpoints.js';

/**
 * CLIENT/SESSION state only (zustand). Server state — anything fetched — belongs in TanStack
 * Query, never here. Tokens are mirrored here for in-memory access but the durable copy lives
 * in SecureStore (auth/secure-tokens.ts); this store is rehydrated from there on launch.
 *
 * Same contract as web's auth-store, so app code reads identically across platforms.
 */
export interface SessionState {
  user: AuthUser | null;
  tokens: TokenPair | null;
  status: 'loading' | 'anonymous' | 'authenticated';
  setSession: (session: { user: AuthUser; tokens: TokenPair }) => void;
  setTokens: (tokens: TokenPair) => void;
  setStatus: (status: SessionState['status']) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  user: null,
  tokens: null,
  status: 'loading',
  setSession: ({ user, tokens }) => set({ user, tokens, status: 'authenticated' }),
  setTokens: (tokens) => set({ tokens }),
  setStatus: (status) => set({ status }),
  clear: () => set({ user: null, tokens: null, status: 'anonymous' }),
}));

/** Convenience selector — the active portal/role from the current session, if any. */
export const useSessionPortal = (): AuthUser['portal'] | null =>
  useSessionStore((s) => s.user?.portal ?? null);
