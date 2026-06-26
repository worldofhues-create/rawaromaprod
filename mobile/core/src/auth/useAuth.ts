import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type {
  AuthEndpoints,
  AuthResult,
  LoginRequest,
  RegisterRequest,
} from '../api/endpoints.js';
import { useSessionStore } from './session-store.js';
import { clearTokens, setTokens } from './secure-tokens.js';

/**
 * Auth mutations (TanStack Query) wired to the injected {@link AuthEndpoints}. On success each
 * mutation:
 *   1. persists the token pair to SecureStore (secure-tokens.ts), then
 *   2. commits the session to the zustand store (session-store.ts).
 * Logout reverses both. The feature owns zero transport — the app injects `endpoints`,
 * exactly mirroring web's `useLogin` pattern.
 */
export function useLogin(
  endpoints: AuthEndpoints,
): UseMutationResult<AuthResult, Error, LoginRequest> {
  const setSession = useSessionStore((s) => s.setSession);
  return useMutation<AuthResult, Error, LoginRequest>({
    mutationKey: ['auth', 'login'],
    mutationFn: (body) => endpoints.login(body),
    onSuccess: async (result) => {
      await setTokens(result.tokens);
      setSession({ user: result.user, tokens: result.tokens });
    },
  });
}

export function useRegister(
  endpoints: AuthEndpoints,
): UseMutationResult<AuthResult, Error, RegisterRequest> {
  const setSession = useSessionStore((s) => s.setSession);
  return useMutation<AuthResult, Error, RegisterRequest>({
    mutationKey: ['auth', 'register'],
    mutationFn: (body) => endpoints.register(body),
    onSuccess: async (result) => {
      await setTokens(result.tokens);
      setSession({ user: result.user, tokens: result.tokens });
    },
  });
}

export function useLogout(): UseMutationResult<void, Error, void> {
  const clear = useSessionStore((s) => s.clear);
  return useMutation<void, Error, void>({
    mutationKey: ['auth', 'logout'],
    mutationFn: async () => {
      await clearTokens();
    },
    onSuccess: () => clear(),
  });
}
