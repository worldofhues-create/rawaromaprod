import * as React from 'react';
import Constants from 'expo-constants';
import {
  ApiClient,
  createAuthEndpoints,
  getAccessToken,
  type AuthEndpoints,
} from '@core/mobile-core';

/**
 * App-side API wiring. The app owns the transport: it constructs the typed {@link ApiClient}
 * (baseURL from Expo config, bearer token pulled from SecureStore per request) and exposes the
 * derived auth endpoints via context. Features stay transport-agnostic — they receive
 * `endpoints` and never touch fetch. Same injection pattern as web's <AuthApiProvider>.
 */
const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:3000';

export const apiClient = new ApiClient({
  baseUrl: API_URL,
  getToken: () => getAccessToken(),
});

const authEndpoints = createAuthEndpoints(apiClient);

const AuthEndpointsContext = React.createContext<AuthEndpoints>(authEndpoints);

export function AuthEndpointsProvider({ children }: { children: React.ReactNode }) {
  return (
    <AuthEndpointsContext.Provider value={authEndpoints}>
      {children}
    </AuthEndpointsContext.Provider>
  );
}

export function useAuthEndpoints(): AuthEndpoints {
  return React.useContext(AuthEndpointsContext);
}
