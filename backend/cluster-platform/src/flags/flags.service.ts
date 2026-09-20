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
import { and, eq } from 'drizzle-orm';
import {
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

type Env = 'staging' | 'prod';

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
   * outbox, then synchronous in-memory push. Critical-flag 2FA step-up is enforced at
   * the controller/guard layer (doc 05 §0.1); this assumes the caller is authorised.
   */
  async setFlag(key: string, input: SetFlagInput, actorId: string): Promise<FlagSnapshot> {
    const { flags, flagStates, flagAudit, outbox } = platformSchema;

    const flagRow = (
      await this.db.select({ id: flags.id }).from(flags).where(eq(flags.key, key)).limit(1)
    )[0];
    if (!flagRow) {
      // Auto-register unknown keys is intentionally NOT done here — keys come from the
      // contracts registry seed. Surface a clear conflict instead.
      throw new Error(`Unknown flag key: ${key}`);
    }

    const targeting = input.targeting ?? null;

    await this.db.transaction(async (tx) => {
      const existing = (
        await tx
          .select({ id: flagStates.id, state: flagStates.state })
          .from(flagStates)
          .where(and(eq(flagStates.flagId, flagRow.id), eq(flagStates.env, input.env)))
          .limit(1)
      )[0];

      const oldState = existing?.state ?? null;

      if (existing) {
        await tx
          .update(flagStates)
          .set({ state: input.state, targeting })
          .where(eq(flagStates.id, existing.id));
      } else {
        await tx.insert(flagStates).values({
          id: uuidv7(),
          flagId: flagRow.id,
          env: input.env,
          state: input.state,
          targeting,
        });
      }

      await tx.insert(flagAudit).values({
        id: uuidv7(),
        flagId: flagRow.id,
        env: input.env,
        oldState,
        newState: input.state,
        reason: input.reason,
        actorId,
      });

      await recordOutbox(
        tx,
        outbox,
        platformContracts.platformEvents.flagChanged,
        { key, env: input.env, state: input.state },
        flagRow.id,
      );
    });

    const updated: FlagSnapshot = { key, state: input.state, targeting };
    // Synchronous in-memory push for THIS env so the edge reflects it immediately.
    if (input.env === this.env) this.snapshot.set(updated);
    return updated;
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
