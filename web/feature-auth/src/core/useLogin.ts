'use client';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { AuthResult, LoginRequest } from './api-client.js';
import { useAuthApi } from './auth-client-context.js';
import { useAuthStore } from './auth-store.js';

/**
 * Login mutation. Server interaction = TanStack Query; on success it commits the session
 * to the zustand store (client state). The transport is the injected apiClient.
 */
export function useLogin(): UseMutationResult<AuthResult, Error, LoginRequest> {
  const api = useAuthApi();
  const setSession = useAuthStore((s) => s.setSession);

  return useMutation<AuthResult, Error, LoginRequest>({
    mutationKey: ['auth', 'login'],
    mutationFn: (body) => api.login(body),
    onSuccess: (result) => {
      setSession({ user: result.user, tokens: result.tokens });
    },
  });
}
