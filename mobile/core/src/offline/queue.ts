import * as SQLite from 'expo-sqlite';

/**
 * Offline mutation queue — the reusable Field-app engine.
 *
 * Field staff act with no connectivity: checklist responses, geo-tagged photos metadata,
 * status changes. Each such write is enqueued as a durable row in SQLite and drained later
 * with retry + exponential backoff. Conflict policy is the caller's job (the docs prescribe
 * "server wins on template version, client wins on responses") — this queue only guarantees
 * at-least-once, ordered, durable delivery of opaque mutations.
 *
 * Design:
 *   - One table `mutation_queue`. Rows are FIFO by `created_at, id`.
 *   - `enqueue` persists a typed mutation (kind + JSON payload) as `pending`.
 *   - `drain` walks pending/eligible rows, hands each to the injected `sender`, and on
 *     success marks `done`; on failure increments `attempts`, sets `next_attempt_at` with
 *     backoff, and stops the row at `maxAttempts` (status `failed`).
 *   - Everything is typed; payloads are generic over a caller-defined `kind` union.
 */

export type MutationStatus = 'pending' | 'done' | 'failed';

export interface QueuedMutation<TKind extends string = string> {
  id: number;
  kind: TKind;
  /** Opaque JSON-serializable payload (e.g. the API path + body to replay). */
  payload: unknown;
  status: MutationStatus;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  lastError: string | null;
}

/** The function that actually performs a mutation against the network. Injected. */
export type MutationSender<TKind extends string = string> = (
  mutation: QueuedMutation<TKind>,
) => Promise<void>;

export interface DrainOptions {
  /** Max times a mutation is retried before it's parked as `failed`. Default 8. */
  maxAttempts?: number;
  /** Base backoff in ms (doubled each attempt, capped). Default 2000. */
  baseBackoffMs?: number;
  /** Backoff ceiling in ms. Default 5 min. */
  maxBackoffMs?: number;
}

export interface DrainResult {
  sent: number;
  failed: number;
  remaining: number;
}

interface QueueRow {
  id: number;
  kind: string;
  payload: string;
  status: MutationStatus;
  attempts: number;
  created_at: number;
  next_attempt_at: number;
  last_error: string | null;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS mutation_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
`;

const CREATE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_queue_drain
    ON mutation_queue (status, next_attempt_at, created_at, id);
`;

function rowToMutation<TKind extends string>(row: QueueRow): QueuedMutation<TKind> {
  return {
    id: row.id,
    kind: row.kind as TKind,
    payload: JSON.parse(row.payload) as unknown,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
  };
}

export class OfflineQueue<TKind extends string = string> {
  private constructor(private readonly db: SQLite.SQLiteDatabase) {}

  /** Open (or create) the queue database and ensure the schema exists. */
  static async open<TKind extends string = string>(
    dbName: string,
  ): Promise<OfflineQueue<TKind>> {
    const db = await SQLite.openDatabaseAsync(dbName);
    await db.execAsync(CREATE_TABLE);
    await db.execAsync(CREATE_INDEX);
    return new OfflineQueue<TKind>(db);
  }

  /** Persist a mutation as `pending`. Returns the new row id. */
  async enqueue(kind: TKind, payload: unknown): Promise<number> {
    const now = Date.now();
    const result = await this.db.runAsync(
      `INSERT INTO mutation_queue (kind, payload, status, attempts, created_at, next_attempt_at)
       VALUES (?, ?, 'pending', 0, ?, 0)`,
      [kind, JSON.stringify(payload ?? null), now],
    );
    return result.lastInsertRowId;
  }

  /** All rows still owed delivery (`pending`), oldest first. */
  async pending(): Promise<QueuedMutation<TKind>[]> {
    const rows = await this.db.getAllAsync<QueueRow>(
      `SELECT * FROM mutation_queue WHERE status = 'pending' ORDER BY created_at, id`,
    );
    return rows.map((r) => rowToMutation<TKind>(r));
  }

  /** Count of rows by status (handy for a sync badge). */
  async counts(): Promise<Record<MutationStatus, number>> {
    const rows = await this.db.getAllAsync<{ status: MutationStatus; n: number }>(
      `SELECT status, COUNT(*) AS n FROM mutation_queue GROUP BY status`,
    );
    const out: Record<MutationStatus, number> = { pending: 0, done: 0, failed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /**
   * Drain eligible mutations through `sender`. Stops early on the first transient failure of
   * a row only for that row — other rows still attempt. Returns a summary. Safe to call on
   * every foreground / connectivity-regain.
   */
  async drain(sender: MutationSender<TKind>, options: DrainOptions = {}): Promise<DrainResult> {
    const maxAttempts = options.maxAttempts ?? 8;
    const baseBackoff = options.baseBackoffMs ?? 2_000;
    const maxBackoff = options.maxBackoffMs ?? 5 * 60_000;
    const now = Date.now();

    const rows = await this.db.getAllAsync<QueueRow>(
      `SELECT * FROM mutation_queue
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY created_at, id`,
      [now],
    );

    let sent = 0;
    let failed = 0;

    for (const row of rows) {
      const mutation = rowToMutation<TKind>(row);
      try {
        await sender(mutation);
        await this.db.runAsync(
          `UPDATE mutation_queue SET status = 'done', last_error = NULL WHERE id = ?`,
          [row.id],
        );
        sent += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        if (attempts >= maxAttempts) {
          await this.db.runAsync(
            `UPDATE mutation_queue SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`,
            [attempts, message, row.id],
          );
          failed += 1;
        } else {
          const backoff = Math.min(baseBackoff * 2 ** (attempts - 1), maxBackoff);
          await this.db.runAsync(
            `UPDATE mutation_queue
             SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
            [attempts, Date.now() + backoff, message, row.id],
          );
        }
      }
    }

    const [{ n: remaining } = { n: 0 }] = await this.db.getAllAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mutation_queue WHERE status = 'pending'`,
    );

    return { sent, failed, remaining };
  }

  /** Manually retry parked (`failed`) rows — resets them to `pending`. */
  async retryFailed(): Promise<number> {
    const result = await this.db.runAsync(
      `UPDATE mutation_queue
       SET status = 'pending', attempts = 0, next_attempt_at = 0, last_error = NULL
       WHERE status = 'failed'`,
    );
    return result.changes;
  }

  /** Delete rows already delivered (housekeeping). */
  async purgeDone(): Promise<number> {
    const result = await this.db.runAsync(`DELETE FROM mutation_queue WHERE status = 'done'`);
    return result.changes;
  }
}
