/**
 * platform FlagsService — the control-plane source of truth (doc 01 §5, doc 06 §2).
 *
 * On boot it hydrates the kernel's in-memory `FlagsService` snapshot from
 * `platform.flags × platform.flag_states`. On an admin mutation it: (1) upserts the
 * state, (2) writes a mandatory-reason `flag_audit` row, (3) records a
 * `platform.flag.changed` outbox event, and (4) pushes the new state into the in-memory
 * snapshot synchronously so the edge `FlagGuard` reflects it instantly (no broker, no
 * poll — doc 01 §5 "in-process pub/sub updates the in-memory snapshot instantly").
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import {
  DomainError,
  EventBus,
  FlagsService as SnapshotService,
  PLATFORM_DB,
  platformSchema,
  recordOutbox,
  type DomainEvent,
  type PlatformDb,
} from '@core/backend-kernel';
import {
  platform as platformContracts,
  type FlagSnapshot,
  type FlagState,
} from '@core/contracts';
import { uuidv7 } from '@core/data-kernel';
import { FLAG_CHAIN_ACTION, FLAG_CHAIN_ENTITY, FLAG_CHAIN_LOCK, chainHash, stableJson } from './flag-chain.js';

type Env = 'staging' | 'prod';
/** The environments a switch has a state in (the contract's `setFlagRequest.env`). */
export const FLAG_ENVS: readonly Env[] = ['staging', 'prod'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The set's answer: the snapshot entry, the environment it was set in, and whether anything moved. */
export interface SetFlagResult extends FlagSnapshot {
  env: Env;
  unchanged: boolean;
}

export interface AdminFlagEnv {
  env: Env;
  state: FlagState;
  /** false: no state was ever set in this environment, so the registry's default applies. */
  set: boolean;
  changedAt: string | null;
  changedBy: string | null;
  from: FlagState | null;
  reason: string | null;
}

export interface AdminFlagsResponse {
  /** The environment THIS process enforces (APP_ENV). */
  env: Env;
  version: string;
  flags: Array<{ key: string; description: string | null; critical: boolean; defaultState: FlagState; envs: AdminFlagEnv[] }>;
}

export interface SetFlagInput {
  env: Env;
  state: FlagState;
  targeting?: FlagSnapshot['targeting'];
  reason: string;
}

@Injectable()
export class PlatformFlagsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformFlagsService.name);
  /** Which env's states drive the live snapshot for this process. */
  private readonly env: Env = process.env.APP_ENV === 'prod' ? 'prod' : 'staging';

  constructor(
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @Inject(SnapshotService) private readonly snapshot: SnapshotService,
    @Inject(EventBus) private readonly bus: EventBus,
  ) {}

  /** Hydrate the in-memory snapshot on startup + subscribe to cross-replica changes. */
  async onModuleInit(): Promise<void> {
    await this.reload();
    this.bus.subscribe(
      platformContracts.platformEvents.flagChanged.type,
      (event: DomainEvent<{ key: string; env: string; state: FlagState }>) => {
        const { key, env, state } = event.payload;
        this.applyChange(key, env, state);
      },
    );
  }

  /** Re-read all flags+states for the active env into the snapshot. */
  async reload(): Promise<void> {
    const snapshot = await this.buildSnapshot();
    this.snapshot.load(snapshot);
    this.logger.log(`flag snapshot loaded (${snapshot.length} flags, env=${this.env})`);
  }

  /** Current snapshot for clients (`GET /flags/snapshot`). */
  list(): FlagSnapshot[] {
    return this.snapshot.all();
  }

  get versionTag(): string {
    return this.snapshot.versionTag;
  }

  /**
   * Admin mutation of a flag state (`PUT /admin/flags/:key`). Atomic upsert + audit +
   * hash-chained audit + outbox, then synchronous in-memory push.
   *
   * FEATURE-SWITCHES: three things this used to get wrong, each of which reached a screen.
   *   - An unknown key threw a bare `Error`, which the exception filter answers 500 with no
   *     words: the RAC OS Platform console said "the factory could not answer" for what is a
   *     plain refusal. It is a 404 naming the key now.
   *   - Setting a switch to the state it already holds wrote a second audit row and a second
   *     `platform.flag.changed` event for a change that did not happen. It now answers the
   *     state as it stands with `unchanged: true` and writes nothing.
   *   - The change was recorded only in `flag_audit`, an ordinary table. It is also appended to
   *     the platform schema's hash chain (flag-chain.ts) in the same transaction, so a row that is
   *     edited or deleted afterwards is detectable.
   * A critical key (`is_critical`, the registry's `critical: true`) needs a fresh sign-in, which
   * the controller checks before this runs (`critical()`).
   */
  async setFlag(key: string, input: SetFlagInput, actorId: string): Promise<SetFlagResult> {
    const { flags, flagStates, flagAudit, outbox, auditEvents } = platformSchema;

    const flagRow = (
      await this.db.select({ id: flags.id }).from(flags).where(eq(flags.key, key)).limit(1)
    )[0];
    if (!flagRow) {
      // Auto-register unknown keys is intentionally NOT done here — keys come from the
      // contracts registry (scripts/migrations/2026-11-29-flags-register.sql registers them).
      throw DomainError.notFound(`There is no switch called "${key}" on this system, so nothing was changed.`);
    }

    const targeting = input.targeting ?? null;
    const reason = input.reason.trim();
    const actor = UUID.test(actorId) ? actorId : null;

    const changed = await this.db.transaction(async (tx) => {
      const existing = (
        await tx
          .select({ id: flagStates.id, state: flagStates.state, targeting: flagStates.targeting })
          .from(flagStates)
          .where(and(eq(flagStates.flagId, flagRow.id), eq(flagStates.env, input.env)))
          .limit(1)
          .for('update')
      )[0];

      const oldState = existing?.state ?? null;
      if (existing && oldState === input.state && stableJson(existing.targeting ?? null) === stableJson(targeting)) return false;

      if (existing) {
        await tx
          .update(flagStates)
          .set({ state: input.state, targeting, updatedAt: new Date(), updatedBy: actor })
          .where(eq(flagStates.id, existing.id));
      } else {
        await tx.insert(flagStates).values({
          id: uuidv7(),
          flagId: flagRow.id,
          env: input.env,
          state: input.state,
          targeting,
          createdBy: actor,
          updatedBy: actor,
        });
      }

      const at = new Date();
      await tx.insert(flagAudit).values({
        id: uuidv7(),
        flagId: flagRow.id,
        env: input.env,
        oldState,
        newState: input.state,
        reason,
        actorId: actor,
        at,
      });

      /* The hash chain: one lock for every append, the head read under it, the row hashed with
         the sequence it takes. */
      await tx.execute(sql`select pg_advisory_xact_lock(${FLAG_CHAIN_LOCK})`);
      const head = (
        await tx
          .select({ chainSeq: auditEvents.chainSeq, rowHash: auditEvents.rowHash })
          .from(auditEvents)
          .where(isNotNull(auditEvents.chainSeq))
          .orderBy(desc(auditEvents.chainSeq))
          .limit(1)
      )[0];
      const prevHash = head?.rowHash ?? null;
      const row = {
        chainSeq: (head?.chainSeq ?? 0n) + 1n,
        occurredAt: at,
        actorId: actor,
        action: FLAG_CHAIN_ACTION,
        entityType: FLAG_CHAIN_ENTITY,
        entityId: flagRow.id,
        before: { key, env: input.env, state: oldState },
        after: { key, env: input.env, state: input.state, reason },
      };
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        ...row,
        prevHash,
        rowHash: chainHash(prevHash, row),
      });

      await recordOutbox(
        tx,
        outbox,
        platformContracts.platformEvents.flagChanged,
        { key, env: input.env, state: input.state },
        flagRow.id,
      );
      return true;
    });

    const updated: FlagSnapshot = { key, state: input.state, targeting };
    if (!changed) return { ...updated, env: input.env, unchanged: true };
    // Synchronous in-memory push for THIS env so the edge reflects it immediately.
    if (input.env === this.env) this.snapshot.set(updated);
    return { ...updated, env: input.env, unchanged: false };
  }

  /** Whether a registered key is critical (null when the key is not registered). */
  async critical(key: string): Promise<boolean | null> {
    const { flags } = platformSchema;
    const row = (await this.db.select({ c: flags.isCritical }).from(flags).where(eq(flags.key, key)).limit(1))[0];
    return row ? row.c === true : null;
  }

  /**
   * FEATURE-SWITCHES: `GET /v1/admin/flags`, every registered switch as an owner reads it. The
   * public snapshot carries only key, state and targeting for THIS process's environment, which is
   * what the edge needs and all a sign-in page may see; the RAC OS Platform console needs to say,
   * per switch, what it does, whether it is critical, and per environment its state, who last
   * changed it, when and why. Nothing here is derived: a state never set reads the registry's
   * default with `changedAt: null`, and the screen says so rather than inventing a history.
   */
  async adminList(): Promise<AdminFlagsResponse> {
    const { flags, flagStates } = platformSchema;
    const defs = await this.db
      .select({ id: flags.id, key: flags.key, description: flags.description, critical: flags.isCritical, defaultState: flags.defaultState })
      .from(flags)
      .orderBy(flags.key);
    const states = await this.db
      .select({ flagId: flagStates.flagId, env: flagStates.env, state: flagStates.state })
      .from(flagStates);
    const last = (await this.db.execute(sql`
      select distinct on (a.flag_id, a.env)
             a.flag_id::text as flag_id, a.env, a.old_state, a.new_state, a.reason, a.actor_id::text as actor_id,
             a.at, u.email, u.user_name
        from platform.flag_audit a
        left join iam.user_master u on u.user_id = a.actor_id
       order by a.flag_id, a.env, a.at desc, a.id desc
    `)) as unknown as Array<{
      flag_id: string; env: string; old_state: string | null; new_state: string; reason: string;
      actor_id: string | null; at: Date | string; email: string | null; user_name: string | null;
    }>;
    const stateOf = new Map(states.map((s) => [`${s.flagId}|${s.env}`, s.state]));
    const lastOf = new Map(last.map((a) => [`${a.flag_id}|${a.env}`, a]));
    return {
      env: this.env,
      version: this.snapshot.versionTag,
      flags: defs.map((f) => ({
        key: f.key,
        description: f.description ?? null,
        critical: f.critical === true,
        defaultState: normalizeState(f.defaultState),
        envs: FLAG_ENVS.map((env) => {
          const st = stateOf.get(`${f.id}|${env}`);
          const a = lastOf.get(`${f.id}|${env}`);
          return {
            env,
            state: normalizeState(st ?? f.defaultState),
            set: st !== undefined,
            changedAt: a ? new Date(a.at).toISOString() : null,
            changedBy: a ? a.email || a.user_name || null : null,
            from: a ? (a.old_state === null ? null : normalizeState(a.old_state)) : null,
            reason: a ? a.reason : null,
          };
        }),
      })),
    };
  }

  /**
   * React to a `platform.flag.changed` event (e.g. published by another api replica via
   * the outbox/bus). Keeps every process's snapshot convergent without a DB round-trip.
   */
  applyChange(key: string, env: string, state: FlagState): void {
    if (env !== this.env) return;
    this.snapshot.set({ key, state, targeting: null });
  }

  /** Build the full snapshot array from flags joined to their active-env states. */
  private async buildSnapshot(): Promise<FlagSnapshot[]> {
    const { flags, flagStates } = platformSchema;
    const rows = await this.db
      .select({
        key: flags.key,
        defaultState: flags.defaultState,
        state: flagStates.state,
        targeting: flagStates.targeting,
      })
      .from(flags)
      .leftJoin(
        flagStates,
        and(eq(flagStates.flagId, flags.id), eq(flagStates.env, this.env)),
      );

    return rows.map((r) => ({
      key: r.key,
      state: normalizeState(r.state ?? r.defaultState),
      targeting: (r.targeting as FlagSnapshot['targeting']) ?? null,
    }));
  }
}

function normalizeState(value: string): FlagState {
  return value === 'on' || value === 'off' || value === 'degraded' ? value : 'off';
}
