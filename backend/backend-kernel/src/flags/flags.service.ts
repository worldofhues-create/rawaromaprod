/**
 * FlagsService — the in-memory flag snapshot the edge layer evaluates in sub-ms.
 *
 * The control plane (doc 01 §5): the platform cluster is the source of truth; on change
 * it publishes `platform.flag.changed` and calls `set()` here so the in-process snapshot
 * updates instantly (no broker needed in a monolith). On boot, `load()` hydrates the map
 * from the DB-backed snapshot. `FlagGuard` reads `get()` to 503 a killed route. This
 * service holds NO Nest deps so it lifts verbatim into the worker too.
 */
import { Injectable } from '@nestjs/common';
import type { FlagSnapshot, FlagState } from '@core/contracts';

@Injectable()
export class FlagsService {
  /** key → current snapshot. The whole kill-switch read path is this Map. */
  private readonly snapshot = new Map<string, FlagSnapshot>();
  /** opaque version bumped on every mutation so SSE clients can detect staleness. */
  private version = 0;

  /** Replace the entire snapshot (boot hydrate / full refresh). */
  load(flags: FlagSnapshot[]): void {
    this.snapshot.clear();
    for (const flag of flags) this.snapshot.set(flag.key, flag);
    this.version += 1;
  }

  /** Upsert one flag (called on `platform.flag.changed`). */
  set(flag: FlagSnapshot): void {
    this.snapshot.set(flag.key, flag);
    this.version += 1;
  }

  /** Current snapshot for a key, or undefined if the flag is unknown. */
  get(key: string): FlagSnapshot | undefined {
    return this.snapshot.get(key);
  }

  /**
   * Resolved boolean enablement for a key. Unknown flag → treated as ON (fail-open) so a
   * missing registration never silently dark-launches a feature; an explicit `off`/
   * `degraded` is what kills a route. `degraded` is "reachable but limited" → still on at
   * the route-guard level (the handler decides what to degrade).
   */
  isEnabled(key: string): boolean {
    const state: FlagState | undefined = this.snapshot.get(key)?.state;
    return state !== 'off';
  }

  /** Full snapshot array (for `GET /flags/snapshot`). */
  all(): FlagSnapshot[] {
    return [...this.snapshot.values()];
  }

  /** Opaque version string for staleness detection. */
  get versionTag(): string {
    return String(this.version);
  }
}
