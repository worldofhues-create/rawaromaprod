'use client';

import * as React from 'react';
import type { AuthApiClient } from './api-client.js';

const AuthApiContext = React.createContext<AuthApiClient | null>(null);

/**
 * Provides the injected {@link AuthApiClient} to the auth hooks. Wrap the auth screens
 * (or the whole app) with this and pass the app's real or mock client.
 */
export function AuthApiProvider({
  client,
  children,
}: {
  client: AuthApiClient;
  children: React.ReactNode;
}) {
  return <AuthApiContext.Provider value={client}>{children}</AuthApiContext.Provider>;
}

export function useAuthApi(): AuthApiClient {
  const client = React.useContext(AuthApiContext);
  if (!client) {
    throw new Error('useAuthApi must be used within an <AuthApiProvider client={…}>');
  }
  return client;
}
