/**
 * Runtime config for the mobile core. Apps pass values in (from Expo's `extra` / env) so the
 * engine stays environment-agnostic and testable. Defaults target local dev.
 */
export interface MobileRuntimeConfig {
  /** Base URL of the platform API edge (no trailing slash). */
  apiUrl: string;
  /** Portal this app authenticates against — becomes the JWT audience claim. */
  defaultPortal: string;
  /** Request timeout in ms. */
  requestTimeoutMs: number;
  /** SQLite database name for the offline queue. */
  offlineDbName: string;
}

export const DEFAULT_CONFIG: MobileRuntimeConfig = {
  apiUrl: 'http://localhost:3000',
  defaultPortal: 'buyer',
  requestTimeoutMs: 15_000,
  offlineDbName: 'mobile-core.db',
};

let current: MobileRuntimeConfig = { ...DEFAULT_CONFIG };

/** Merge app-provided config over the defaults. Call once at app boot. */
export function configure(overrides: Partial<MobileRuntimeConfig>): MobileRuntimeConfig {
  current = { ...current, ...overrides };
  return current;
}

export function getConfig(): MobileRuntimeConfig {
  return current;
}
