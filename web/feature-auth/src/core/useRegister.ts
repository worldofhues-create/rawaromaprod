'use client';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { AuthResult, RegisterRequest } from './api-client.js';
import { useAuthApi } from './auth-client-context.js';
import { useAuthStore } from './auth-store.js';

/**
 * Register mutation. Mirrors {@link useLogin}: TanStack Query for the call, zustand for the
 * resulting session, transport injected via the apiClient.
 */
export function useRegister(): UseMutationResult<AuthResult, Error, RegisterRequest> {
  const api = useAuthApi();
  const setSession = useAuthStore((s) => s.setSession);

  return useMutation<AuthResult, Error, RegisterRequest>({
    mutationKey: ['auth', 'register'],
    mutationFn: (body) => api.register(body),
    onSuccess: (result) => {
      setSession({ user: result.user, tokens: result.tokens });
    },
  });
}
