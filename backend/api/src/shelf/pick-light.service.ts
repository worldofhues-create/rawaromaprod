/**
 * Pick-to-light, device-agnostic (lane produce, owner decision 2026-09-29): "emit put-away light
 * commands through the documented HTTP/HMAC shape {rack, shelf, bin, qty, colour, task_id} to a
 * configurable controller URL set in the settings UI, plus a simulator". Wire contract:
 * docs/bridge/PICK_LIGHT.md.
 *
 *   enqueue()  inside the task's own transaction: one `location.pick_light_command` row per light
 *              change — `on` when a put-away/pick task is assigned a bin (colour by task kind),
 *              `off` (colour 'off', qty 0) when the task is done or cancelled. Always recorded,
 *              whatever the mode, so turning a controller on later never needs a back-fill.
 *   drain()    the worker, every 2 s (PickLightRelayService): per the in-app config —
 *                off        → SKIPPED (nothing leaves the box)
 *                simulator  → signed exactly as a controller would receive it, verified, and
 *                             applied to `location.pick_light_sim_state`, which the Shelf display
 *                             shows as lit bins
 *                http       → POST to the controller URL, `X-PickLight-Signature: sha256=<hex HMAC
 *                             of the raw body>`; 2xx → SENT; failure → retried on backoff
 *                             (2 s doubling, capped at 5 min), PARKED after 12 attempts.
 *              Fail closed: http mode with no URL or no openable secret sends nothing.
 *
 * The body is EXACTLY the six fields. No product, customer, batch or formula data goes to a
 * light controller — it only needs where, how many and which colour.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { bridge as bridgeContracts } from '@core/contracts';
import { PICK_LIGHT_AAD, openSecret, sealSecret } from '../bridge/secret-box.js';
import { signBody, verifyBody } from '../bridge/signing.js';
import { SHELF_DB, type ShelfDb, type ShelfTx } from './shelf.tokens.js';

export type LightColour = 'blue' | 'green' | 'amber' | 'red' | 'white' | 'off';

/** The one wire shape (docs/bridge/PICK_LIGHT.md). */
export interface PickLightCommand {
  readonly task_id: string;
  readonly rack: string;
  readonly shelf: string | null;
  readonly bin: string | null;
  readonly qty: number;
  readonly colour: LightColour;
}

export const PICK_LIGHT_SIGNATURE_HEADER = 'x-picklight-signature';
/** Signs simulator commands when no controller secret is configured. Not a secret: the simulator
 *  is in-process; it exists so the simulator verifies the same signed bytes a controller would. */
export const SIMULATOR_KEY = 'rawprod-pick-light-simulator';
export const PICK_LIGHT_MAX_ATTEMPTS = 12;
const BACKOFF_CAP_SECONDS = 300;

/** Colour per task kind: blue = put away here, green = pick from here, amber = move. */
export function colourFor(kind: string): LightColour {
  return kind === 'PICK' ? 'green' : kind === 'MOVE' ? 'amber' : kind === 'TEST' ? 'white' : 'blue';
}

export interface PickLightStatus {
  mode: 'off' | 'simulator' | 'http';
  controllerUrl: string | null;
  hasSecret: boolean;
  configuredAt: string | null;
  configuredBy: string | null;
  pending: number;
  parked: number;
  lastSentAt: string | null;
}

@Injectable()
export class PickLightService implements OnModuleDestroy {
  private readonly logger = new Logger(PickLightService.name);
  private draining = false;
  private stopped = false;
  /** Transport seam for tests; production uses the global fetch. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(@Inject(SHELF_DB) private readonly db: ShelfDb) {}

  onModuleDestroy(): void { this.stopped = true; }

  /** Queue one light change inside the caller's transaction. */
  async enqueue(tx: ShelfTx, cmd: PickLightCommand): Promise<void> {
    await tx.execute(sql`
      insert into location.pick_light_command (shelf_task_id, action, body)
      values (${cmd.task_id}::uuid, ${cmd.colour === 'off' ? 'off' : 'on'}, ${JSON.stringify(cmd)}::jsonb)
    `);
  }

  async status(): Promise<PickLightStatus> {
    const cfg = await this.config();
    const [counts] = (await this.db.execute(sql`
      select count(*) filter (where status = 'PENDING')::int as pending,
             count(*) filter (where status = 'PARKED')::int as parked,
             max(sent_at) as last_sent
        from location.pick_light_command
    `)) as unknown as Array<{ pending: number; parked: number; last_sent: Date | null }>;
    return {
      mode: (cfg?.mode as PickLightStatus['mode']) ?? 'off',
      controllerUrl: cfg?.controller_url ?? null,
      hasSecret: !!cfg?.hmac_secret_sealed,
      configuredAt: cfg?.configured_at ? new Date(cfg.configured_at).toISOString() : null,
      configuredBy: cfg?.configured_by ?? null,
      pending: Number(counts?.pending ?? 0),
      parked: Number(counts?.parked ?? 0),
      lastSentAt: counts?.last_sent ? new Date(counts.last_sent).toISOString() : null,
    };
  }

  /** PUT /v1/shelf/pick-light/config — body already validated by configurePickLightRequest. */
  async configure(body: bridgeContracts.ConfigurePickLightRequest, actorId: string): Promise<PickLightStatus> {
    const existing = await this.config();
    const sealed = body.hmacSecret ? sealSecret(body.hmacSecret, PICK_LIGHT_AAD) : existing?.hmac_secret_sealed ?? null;
    const url = body.controllerUrl === undefined ? existing?.controller_url ?? null : body.controllerUrl;
    if (body.mode === 'http' && (!url || !sealed)) {
      throw new PickLightConfigError('Controller mode needs both the controller URL and a shared secret (at least 16 characters).');
    }
    await this.db.execute(sql`
      insert into location.pick_light_config (id, mode, controller_url, hmac_secret_sealed, configured_at, configured_by)
      values ('default', ${body.mode}, ${url}, ${sealed}, now(), ${actorId})
      on conflict (id) do update set mode = excluded.mode, controller_url = excluded.controller_url,
        hmac_secret_sealed = excluded.hmac_secret_sealed, configured_at = now(), configured_by = excluded.configured_by
    `);
    return this.status();
  }

  /** Queue a white test light on one bin (or the first bin) — the settings screen's "Test". */
  async test(binCode: string | null): Promise<{ queued: PickLightCommand }> {
    const bin = ((await this.db.execute(sql`
      select rk.rack_code, sh.shelf_code, bn.bin_code
        from location.bin_master bn
        left join location.shelf_master sh on sh.shelf_id = bn.shelf_id
        left join location.rack_master rk on rk.rack_id = sh.rack_id
       where (${binCode}::text is null or lower(bn.bin_code) = lower(${binCode}::text))
       order by bn.bin_code limit 1
    `)) as unknown as Array<{ rack_code: string | null; shelf_code: string | null; bin_code: string | null }>)[0];
    const cmd: PickLightCommand = {
      task_id: '00000000-0000-4000-8000-000000000000',
      rack: bin?.rack_code ?? 'TEST', shelf: bin?.shelf_code ?? null, bin: bin?.bin_code ?? null,
      qty: 1, colour: 'white',
    };
    await this.db.transaction((tx) => this.enqueue(tx, cmd));
    return { queued: cmd };
  }

  /** The simulator's lit bins, optionally only on the given racks (the shelf display's zone). */
  async simulatorState(rackCodes?: string[]) {
    const racks = rackCodes ? pgTextArray(rackCodes) : null;
    return (await this.db.execute(sql`
      select location_key as "locationKey", rack, shelf, bin, lit, colour, qty::float as qty,
             shelf_task_id::text as "taskId", signature_ok as "signatureOk", updated_at as "updatedAt"
        from location.pick_light_sim_state
       where lit and (${racks}::text[] is null or rack = any(${racks}::text[]))
       order by rack, shelf, bin
    `)) as unknown as Array<Record<string, unknown>>;
  }

  /** Fires only where the ScheduleModule runs — the worker (same as BridgeRelayService.tick). */
  @Interval('pick-light-drain', 2000)
  async tick(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try { await this.drain(); }
    catch (err) { this.logger.error(`pick-light drain failed: ${(err as Error).message}`); }
    finally { this.draining = false; }
  }

  /** One pass over the due commands. Public so a test drives it without the timer. */
  async drain(): Promise<{ sent: number; simulated: number; skipped: number; failed: number }> {
    const out = { sent: 0, simulated: 0, skipped: 0, failed: 0 };
    const cfg = await this.config();
    const mode = cfg?.mode ?? 'off';
    const due = (await this.db.execute(sql`
      select command_id::text as id, body, attempts from location.pick_light_command
       where status = 'PENDING' and next_attempt_at <= now()
       order by seq limit 100
    `)) as unknown as Array<{ id: string; body: PickLightCommand; attempts: number }>;
    if (due.length === 0) return out;

    if (mode === 'off') {
      await this.db.execute(sql`update location.pick_light_command set status = 'SKIPPED', last_error = 'pick-to-light is off'
                                  where command_id = any(${`{${due.map((d) => d.id).join(',')}}`}::uuid[])`);
      out.skipped = due.length;
      return out;
    }
    const secret = cfg?.hmac_secret_sealed ? openSecret(cfg.hmac_secret_sealed, PICK_LIGHT_AAD) : null;

    for (const d of due) {
      const raw = JSON.stringify(d.body);
      if (mode === 'simulator') {
        const key = secret ?? SIMULATOR_KEY;
        const signature = signBody(raw, key);
        await this.applyToSimulator(raw, signature, key, d.id);
        out.simulated++;
        continue;
      }
      // http — fail closed without a URL or an openable secret.
      if (!cfg?.controller_url || !secret) {
        await this.fail(d.id, d.attempts, null, 'controller URL or secret not configured');
        out.failed++;
        continue;
      }
      try {
        const res = await this.fetchImpl(cfg.controller_url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [PICK_LIGHT_SIGNATURE_HEADER]: signBody(raw, secret),
            'x-picklight-task-id': d.body.task_id,
          },
          body: raw,
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          await this.db.execute(sql`update location.pick_light_command set status = 'SENT', sent_at = now(),
                                      attempts = attempts + 1, last_http_status = ${res.status} where command_id = ${d.id}::uuid`);
          out.sent++;
        } else {
          await this.fail(d.id, d.attempts, res.status, `http_${res.status}`);
          out.failed++;
        }
      } catch (err) {
        await this.fail(d.id, d.attempts, null, `network: ${(err as Error).message.slice(0, 200)}`);
        out.failed++;
      }
    }
    return out;
  }

  /** The simulator: verify the signature exactly as a controller must, then light/unlight the bin. */
  async applyToSimulator(rawBody: string, signature: string, key: string, commandId: string | null): Promise<boolean> {
    const ok = verifyBody(rawBody, key, signature);
    const cmd = JSON.parse(rawBody) as PickLightCommand;
    const locationKey = `${cmd.rack}|${cmd.shelf ?? ''}|${cmd.bin ?? ''}`;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into location.pick_light_sim_state (location_key, rack, shelf, bin, lit, colour, qty, shelf_task_id, signature_ok, last_command, updated_at)
        values (${locationKey}, ${cmd.rack}, ${cmd.shelf}, ${cmd.bin}, ${ok && cmd.colour !== 'off'}, ${cmd.colour}, ${cmd.qty},
                ${cmd.task_id}::uuid, ${ok}, ${rawBody}::jsonb, now())
        on conflict (location_key) do update set lit = excluded.lit, colour = excluded.colour, qty = excluded.qty,
          shelf_task_id = excluded.shelf_task_id, signature_ok = excluded.signature_ok, last_command = excluded.last_command, updated_at = now()
      `);
      if (commandId) {
        await tx.execute(sql`update location.pick_light_command set status = 'SIMULATED', sent_at = now(), attempts = attempts + 1
                               where command_id = ${commandId}::uuid`);
      }
    });
    return ok;
  }

  private async fail(id: string, attemptsBefore: number, httpStatus: number | null, error: string): Promise<void> {
    const attempts = attemptsBefore + 1;
    const park = attempts >= PICK_LIGHT_MAX_ATTEMPTS;
    const wait = Math.min(2 ** attempts, BACKOFF_CAP_SECONDS);
    await this.db.execute(sql`
      update location.pick_light_command
         set attempts = ${attempts}, last_error = ${error}, last_http_status = ${httpStatus}::int,
             status = ${park ? 'PARKED' : 'PENDING'},
             next_attempt_at = now() + make_interval(secs => ${wait}::double precision)
       where command_id = ${id}::uuid
    `);
  }

  private async config() {
    return ((await this.db.execute(sql`
      select mode, controller_url, hmac_secret_sealed, configured_at, configured_by from location.pick_light_config where id = 'default'
    `)) as unknown as Array<{ mode: string; controller_url: string | null; hmac_secret_sealed: string | null; configured_at: Date | null; configured_by: string | null }>)[0];
  }
}

export class PickLightConfigError extends Error {}

/** A Postgres text[] literal for a bound parameter (quotes/braces/commas stripped from values). */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${String(v).replace(/["\\{},]/g, '')}"`).join(',')}}`;
}
