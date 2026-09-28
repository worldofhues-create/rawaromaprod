/**
 * recordProduceAlert — lane produce (owner requirement 2026-09-29): "Factory and every console must
 * get alerts to PRODUCE". One shared writer, called INSIDE the caller's own transaction beside the
 * state change the alert is about (a requirement landing, a QC verdict, a blocked plan), exactly
 * like `emitBridgeOutbound` beside it: a rollback of the change rolls back its alert.
 *
 *   production.produce_alert   the consoles' feed (GET /v1/produce/alerts?after=<seq>): badge,
 *                              toast and sound per console convention. Role-filtered on read.
 *   production.outbox          `production.produce.<kind>` — the worker's EmailNotifierService routes
 *                              it to the same roles by email (its RULES table), so an alert also
 *                              reaches someone who is not looking at a console.
 *
 * `dedupeKey` makes an alert fire once (`on conflict do nothing`) — a re-delivered requirement, a
 * second click on a blocked plan, or the overdue sweep running again never repeats it. Plain SQL,
 * no schema import, so this file stays domain-free (same reasoning as bridge-emit.ts).
 *
 * TEXT ONLY, NEVER FORMULA CONTENT: callers pass product/SKU/batch/order words. A formula alert
 * names the product that has no approved formula, never a formula name, material or percentage.
 */
import { sql } from 'drizzle-orm';
import type { BridgeEmitTx } from './bridge-emit.js';

export type ProduceAlertKind =
  | 'high_value_requirement'
  | 'overdue_requirement'
  | 'formula_needed'
  | 'qc_failed'
  | 'label_blocked'
  | 'fg_received_not_sent';

export interface ProduceAlertInput {
  kind: ProduceAlertKind;
  severity: 'high' | 'med' | 'low';
  title: string;
  detail?: string | null;
  /** Role codes the alert is for. `owner` sees every alert regardless. */
  roles: string[];
  refType?: string | null;
  refId?: string | null;
  dedupeKey: string;
}

/** Inserts the alert (once per dedupeKey) and its email event. Returns true if it was new. */
export async function recordProduceAlert(tx: BridgeEmitTx, a: ProduceAlertInput): Promise<boolean> {
  const roles = `{${a.roles.map((r) => `"${r.replace(/["\\{},]/g, '')}"`).join(',')}}`;
  const rows = (await tx.execute(sql`
    insert into production.produce_alert (kind, severity, title, detail, roles, ref_type, ref_id, dedupe_key)
    values (${a.kind}, ${a.severity}, ${a.title}, ${a.detail ?? null}, ${roles}::text[],
            ${a.refType ?? null}, ${a.refId ?? null}::uuid, ${a.dedupeKey})
    on conflict (dedupe_key) do nothing
    returning produce_alert_id
  `)) as unknown as Array<{ produce_alert_id: string }>;
  const created = rows[0];
  if (!created) return false;
  const payload = JSON.stringify({
    produceAlertId: created.produce_alert_id, kind: a.kind, title: a.title, detail: a.detail ?? null, roles: a.roles,
  });
  await tx.execute(sql`
    insert into production.outbox (type, aggregate_id, payload)
    values (${`production.produce.${a.kind}`}, ${created.produce_alert_id}::uuid, ${payload}::jsonb)
  `);
  return true;
}
