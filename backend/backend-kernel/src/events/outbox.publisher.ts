/**
 * OutboxPublisher — drains every registered cluster outbox onto the EventBus.
 *
 * The reliability half of the transactional-outbox pattern (doc 01 §0 ¶3): producers
 * write `<schema>.outbox` rows inside their domain transaction; this scheduled service
 * polls `published_at IS NULL` in occurrence order, republishes each row as a domain
 * event, and stamps `published_at`. Crash-safe: an event already on the bus but not yet
 * marked is simply re-published next tick — subscribers are idempotent, so at-least-once
 * is the contract. Runs in the `worker` process (not the api), guarded so two ticks
 * never overlap.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ConfigService } from '../config/config.service.js';
import { EventBus, type DomainEvent } from './event-bus.js';
import { OUTBOX_SOURCES, type OutboxSource } from './outbox.registry.js';

@Injectable()
export class OutboxPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly batch: number;
  private draining = false;
  private stopped = false;

  constructor(
    private readonly bus: EventBus,
    private readonly config: ConfigService,
    @Inject(OUTBOX_SOURCES) private readonly sources: OutboxSource[],
  ) {
    this.batch = this.config.get('OUTBOX_BATCH');
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  /**
   * Scheduled drain. The fixed-interval decorator keeps the worker simple; the
   * `draining` re-entrancy guard means a slow tick never stacks. Default 2s
   * (`OUTBOX_POLL_MS`); latency-sensitive flows still feel instant because flag changes
   * also push synchronously through `FlagsService`.
   */
  @Interval('outbox-drain', 2000)
  async tick(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      for (const source of this.sources) {
        await this.drainSource(source);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Drain one cluster's outbox: read a batch, publish, mark published. */
  private async drainSource(source: OutboxSource): Promise<void> {
    const { db, table } = source;
    // The publisher is schema-agnostic: it works over the structural `OutboxTable` column
    // surface (`table.publishedAt`, `table.id`, …) for filters/ordering. Drizzle's query
    // builders are typed to a concrete table generic, so the dynamic `.from()/.update()`
    // calls take a loose `LooseDb` view — the runtime row/column shape is fixed by the
    // kernel `outboxTable()` factory (see `OutboxRow`), so this is safe.
    const loose = db as unknown as LooseDb;

    const rows = (await loose
      .select()
      .from(table)
      .where(isNull(table.publishedAt))
      .orderBy(asc(table.occurredAt), asc(table.seq))
      .limit(this.batch)) as OutboxRow[];

    if (rows.length === 0) return;

    const publishedIds: string[] = [];
    for (const row of rows) {
      const event: DomainEvent = {
        id: String(row.id),
        type: row.type,
        occurredAt:
          row.occurredAt instanceof Date
            ? row.occurredAt.toISOString()
            : String(row.occurredAt),
        actor: null,
        requestId: '',
        version: 1,
        payload: row.payload,
      };
      try {
        await this.bus.publish(event);
        publishedIds.push(String(row.id));
      } catch (err) {
        // Bump attempts so a poison row backs off instead of blocking the queue head.
        await loose
          .update(table)
          .set({ attempts: sql`${table.attempts} + 1` })
          .where(and(isNull(table.publishedAt), eq(table.id, String(row.id))));
        this.logger.error(
          `[${source.cluster}] failed to publish outbox row ${String(row.id)}: ${String(err)}`,
        );
      }
    }

    if (publishedIds.length > 0) {
      await loose
        .update(table)
        .set({ publishedAt: new Date() })
        .where(and(isNull(table.publishedAt), inArray(table.id, publishedIds)));
      this.logger.debug(`[${source.cluster}] published ${publishedIds.length} event(s)`);
    }
  }
}

/** The shape we read off an outbox row (kernel `outboxTable()` columns). */
interface OutboxRow {
  id: unknown;
  type: string;
  payload: unknown;
  occurredAt: Date | string;
}

/**
 * A deliberately loose view of the Drizzle db for the schema-agnostic outbox queries.
 * The query/update builders are chainable and accept the structural outbox columns; the
 * `.set()` payload is intentionally untyped (the column set is fixed by `outboxTable()`).
 * Each chain step is a thenable so `await` on the final builder resolves the rows.
 */
type SqlArg = unknown;

interface SelectChain extends PromiseLike<unknown[]> {
  where(condition: SqlArg): SelectChain;
  orderBy(...columns: SqlArg[]): SelectChain;
  limit(n: number): SelectChain;
}
interface UpdateChain extends PromiseLike<unknown> {
  set(values: Record<string, unknown>): UpdateChain;
  where(condition: SqlArg): UpdateChain;
}
interface LooseDb {
  select(): { from(table: SqlArg): SelectChain };
  update(table: SqlArg): UpdateChain;
}
