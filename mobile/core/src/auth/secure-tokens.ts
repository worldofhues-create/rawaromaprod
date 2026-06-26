import * as SecureStore from 'expo-secure-store';
import type { TokenPair } from '../api/endpoints.js';

/**
 * SECURITY: tokens live in the device keychain/keystore via expo-secure-store — NEVER in
 * AsyncStorage (which is plaintext). This wrapper is the only place tokens are read/written,
 * so the storage backend (and any future hardware-backed / biometric-gated variant) is
 * swappable in one file.
 *
 * Follow-up hardening documented in the README: certificate pinning to the API host and
 * optional biometric unlock (`requireAuthentication: true` once a passcode is enrolled).
 */
const ACCESS_KEY = 'auth.accessToken';
const REFRESH_KEY = 'auth.refreshToken';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

export async function setTokens(tokens: Pick<TokenPair, 'accessToken' | 'refreshToken'>): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
    SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
  ]);
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_KEY);
}

export async function getTokens(): Promise<StoredTokens | null> {
  const [accessToken, refreshToken] = await Promise.all([
    getAccessToken(),
    getRefreshToken(),
  ]);
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}
