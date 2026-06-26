import { create } from 'zustand';
import type { AuthUser, TokenPair } from './api-client.js';

/**
 * CLIENT/SESSION state only (zustand). Server state — anything fetched — belongs in
 * TanStack Query, never here. This store holds the post-login session: the current user,
 * the token pair, and derived auth status.
 */
export interface AuthState {
  user: AuthUser | null;
  tokens: TokenPair | null;
  status: 'anonymous' | 'authenticated';
  setSession: (session: { user: AuthUser; tokens: TokenPair }) => void;
  setTokens: (tokens: TokenPair) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  tokens: null,
  status: 'anonymous',
  setSession: ({ user, tokens }) => set({ user, tokens, status: 'authenticated' }),
  setTokens: (tokens) => set({ tokens }),
  clear: () => set({ user: null, tokens: null, status: 'anonymous' }),
}));

/** Convenience selector — the active portal/role from the current session, if any. */
export const useSessionPortal = (): AuthUser['portal'] | null =>
  useAuthStore((s) => s.user?.portal ?? null);
