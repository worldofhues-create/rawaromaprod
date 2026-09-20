import { create } from 'zustand';
import { platform, type FlagKey, type FlagState } from '@core/contracts';
import type { z } from 'zod';
import type { ApiClient } from '../api/client.js';

type FlagSnapshotResponse = z.infer<typeof platform.flags.flagSnapshotResponse>;

/**
 * Kill-switch client. Mirrors the platform control plane on the device: fetch the per-portal
 * flag snapshot at launch and on every foreground, cache it in memory, and evaluate
 * `isEnabled(key)` in sub-ms with no network. A killed module simply disappears from the UI
 * (the app reads `isEnabled` to gate tabs/screens). Same `portal.module.feature` keys as web.
 *
 * `percent`/role/city targeting is intentionally NOT evaluated client-side here — the edge
 * resolves targeting and the snapshot it returns is already narrowed to this client. We treat
 * `state === 'on'` (and `'degraded'`) as enabled, `'off'` as killed.
 */
interface FlagsState {
  version: string | null;
  states: Record<string, FlagState>;
  lastFetchedAt: number | null;
  setSnapshot: (snapshot: FlagSnapshotResponse) => void;
}

const useFlagsStore = create<FlagsState>((set) => ({
  version: null,
  states: {},
  lastFetchedAt: null,
  setSnapshot: (snapshot) =>
    set({
      version: snapshot.version,
      lastFetchedAt: Date.now(),
      states: Object.fromEntries(snapshot.flags.map((f) => [f.key, f.state])),
    }),
}));

export interface FlagsClient {
  /** Fetch the snapshot for a portal and cache it. Call on launch + on app foreground. */
  refresh: (portal: string) => Promise<void>;
  /** Sub-ms in-memory evaluation. Unknown keys default to enabled (fail-open for UI). */
  isEnabled: (key: FlagKey | string) => boolean;
}

export function createFlagsClient(api: ApiClient): FlagsClient {
  return {
    async refresh(portal: string) {
      const snapshot = await api.request(
        `/flags/snapshot?portal=${encodeURIComponent(portal)}`,
        {
          method: 'GET',
          anonymous: true,
          responseSchema: platform.flags.flagSnapshotResponse,
        },
      );
      useFlagsStore.getState().setSnapshot(snapshot);
    },
    isEnabled(key: FlagKey | string) {
      const state = useFlagsStore.getState().states[key];
      if (state === undefined) return true;
      return state !== 'off';
    },
  };
}

/** React hook form of `isEnabled` — re-renders when the snapshot changes. */
export function useFlag(key: FlagKey | string): boolean {
  return useFlagsStore((s) => {
    const state = s.states[key];
    return state === undefined ? true : state !== 'off';
  });
}

/** Expose the snapshot version (for staleness checks / debugging). */
export function useFlagsVersion(): string | null {
  return useFlagsStore((s) => s.version);
}
