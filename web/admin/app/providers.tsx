'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthApiProvider, type AuthApiClient } from '@core/feature-auth';

/**
 * Demo auth client. In a real app this is the typed client generated from the contracts'
 * OpenAPI spec (or a thin fetch wrapper) — injected here so @core/feature-auth stays
 * transport-agnostic. Swap this object; the screens don't change.
 */
const demoAuthClient: AuthApiClient = {
  async login(body) {
    await new Promise((r) => setTimeout(r, 400));
    return {
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        fullName: 'Demo Admin',
        email: body.identifier.includes('@') ? body.identifier : null,
        mobile: body.identifier.includes('@') ? null : body.identifier,
        status: 'active',
        roles: ['admin'],
        portal: body.portal,
      },
      tokens: { accessToken: 'demo.access', refreshToken: 'demo.refresh', expiresIn: 900 },
    };
  },
  async register(body) {
    await new Promise((r) => setTimeout(r, 400));
    return {
      user: {
        id: '00000000-0000-0000-0000-000000000002',
        fullName: body.fullName,
        email: body.email ?? null,
        mobile: body.mobile ?? null,
        status: 'pending',
        roles: [],
        portal: body.portal,
      },
      tokens: { accessToken: 'demo.access', refreshToken: 'demo.refresh', expiresIn: 900 },
    };
  },
  async forgotPassword() {
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true } as const;
  },
};

export function Providers({ children }: { children: React.ReactNode }) {
  // One client per browser session — created lazily, kept stable across renders.
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthApiProvider client={demoAuthClient}>{children}</AuthApiProvider>
    </QueryClientProvider>
  );
}
