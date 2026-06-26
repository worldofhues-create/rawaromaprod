// @core/feature-auth — core (platform-agnostic logic: hooks, store, client contract).
export type {
  AuthApiClient,
  LoginRequest,
  RegisterRequest,
  ForgotPasswordRequest,
  AuthResult,
  AuthUser,
  TokenPair,
} from './api-client.js';
export { AuthApiProvider, useAuthApi } from './auth-client-context.js';
export { useAuthStore, useSessionPortal, type AuthState } from './auth-store.js';
export { useLogin } from './useLogin.js';
export { useRegister } from './useRegister.js';
