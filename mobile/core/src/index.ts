// @core/mobile-core — Tier-1 cross-app mobile engine (React Native, no UI).

// Config
export {
  configure,
  getConfig,
  DEFAULT_CONFIG,
  type MobileRuntimeConfig,
} from './config.js';

// API
export { ApiClient, ApiClientError, type ApiClientOptions, type RequestOptions } from './api/client.js';
export {
  createAuthEndpoints,
  type AuthEndpoints,
  type LoginRequest,
  type RegisterRequest,
  type RefreshRequest,
  type AuthResult,
  type AuthUser,
  type TokenPair,
  type MeProfile,
} from './api/endpoints.js';

// Auth
export {
  setTokens,
  getTokens,
  getAccessToken,
  getRefreshToken,
  clearTokens,
  type StoredTokens,
} from './auth/secure-tokens.js';
export {
  useSessionStore,
  useSessionPortal,
  type SessionState,
} from './auth/session-store.js';
export { useLogin, useRegister, useLogout } from './auth/useAuth.js';

// Flags (kill-switch)
export {
  createFlagsClient,
  useFlag,
  useFlagsVersion,
  type FlagsClient,
} from './flags/flags-client.js';

// Offline mutation queue (Field-app engine)
export {
  OfflineQueue,
  type QueuedMutation,
  type MutationSender,
  type MutationStatus,
  type DrainOptions,
  type DrainResult,
} from './offline/queue.js';
