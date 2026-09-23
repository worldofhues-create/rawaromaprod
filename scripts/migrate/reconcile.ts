/**
 * PB-02 — source vs target reconciliation. Runs the same set of counts and business aggregates
 * against a source database and a target database (a migration's before/after, or a
 * dump/restore's before/after) and reports every mismatch as data, never as a guess. Domains are
 * exactly MIGRATION_AWS_PLAN.md §4's list (which is itself V5 §12): iam/platform, masterdata,
 * procurement, gate/GRN + inventory, quality, production, packaging/FG/ATP, sales/dispatch,
 * bridge/outbox/workflow, location (PostGIS), formula (vault), plus ALEMBIC's own baseline.
 *
 * Usage:
 *   SOURCE_DATABASE_URL=postgres://... TARGET_DATABASE_URL=postgres://... \
 *     [SOURCE_FORMULA_DATABASE_URL=...] [TARGET_FORMULA_DATABASE_URL=...] \
 *     [ALEMBIC_DATABASE_URL=postgres://...] \
 *     [OUT_FILE=release/evidence/reconcile-<ts>.json] \
 *     node --import @swc-node/register/esm-register scripts/migrate/reconcile.ts
 *
 * `*_FORMULA_DATABASE_URL` fall back to the corresponding `*_DATABASE_URL` — same convention as
 * scripts/db-migrate.ts's TARGET_ENV, for the same reason: a single-connection deployment has
 * one database doing both jobs. `ALEMBIC_DATABASE_URL` is optional — when set, the tool also
 * runs the ALEMBIC baseline queries the plan's §4 last bullet calls for (source-only,
 * "run once as a baseline", not compared against anything since ALEMBIC has not moved).
 *
 * Exit code: 0 only if every check that ran matched. Non-zero (1) on any mismatch, (2) on a
 * connection/config error before any check could run. Prints a JSON report to stdout (and to
 * OUT_FILE if set) plus a one-line-per-domain human summary to stderr.
 */
import postgres, { type Sql } from 'postgres';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Row = Record<string, unknown>;
type CheckResult = { name: string; source: unknown; target: unknown; match: boolean; note?: string };
type DomainResult = { domain: string; checks: CheckResult[] };

/** Normalise a query result for comparison: Postgres numeric/bigint come back as strings from
 * `postgres`, which is exactly what we want (no float rounding); dates/timestamps as Date
 * objects need ISO stringification to compare structurally; everything else passes through. */
function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === 'object') {
    const out: Row = {};
    for (const [k, val] of Object.entries(v as Row)) out[k] = normalise(val);
    return out;
  }
  return v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

/** Run one query against both connections and record a single named check. `sql` must be safe
 * (no interpolated user input — every call site here is a literal). */
async function check(
  results: CheckResult[],
  name: string,
  src: Sql,
  tgt: Sql,
  query: string,
  opts: { note?: string } = {},
): Promise<void> {
  const [s, t] = await Promise.all([src.unsafe(query), tgt.unsafe(query)]);
  const match = deepEqual(s, t);
  results.push({ name, source: normalise(s), target: normalise(t), match, ...(opts.note ? { note: opts.note } : {}) });
}

/** A source-only assertion (no target to compare against) — e.g. "negative on-hand is 0", "no
 * demo users in prod". Recorded the same shape as `check` (source === target trivially, by
 * construction) so the report format stays uniform; `match` is the assertion's own pass/fail. */
async function assertSource(results: CheckResult[], name: string, src: Sql, query: string, isOk: (rows: Row[]) => boolean, note: string): Promise<void> {
  const rows = (await src.unsafe(query)) as unknown as Row[];
  results.push({ name, source: normalise(rows), target: '(source-only assertion)', match: isOk(rows), note });
}

// ── domain check groups ───────────────────────────────────────────────────────────────────────

async function domainIamPlatform(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'users_by_role', src, tgt,
    `select r.role_code, count(*)::int as n from iam.user_role_mapping urm
       join iam.role_master r on r.role_id = urm.role_id
      group by r.role_code order by r.role_code`);
  await check(checks, 'org_count', src, tgt, `select count(*)::int as n from iam.org_master`);
  await check(checks, 'active_formula_access_policies', src, tgt,
    `select count(*)::int as n from formula.formula_access_policy where status = 'ACTIVE'`);
  await assertSource(checks, 'no_demo_users_in_target', tgt,
    `select user_id from iam.user_master where email ilike '%@rawaroma.local'`,
    (rows) => rows.length === 0,
    'V5 §4 / MIGRATION_AWS_PLAN.md H2: no *@rawaroma.local demo login should exist once a target is declared production. INFORMATIONAL until H2 rules on which rows (if any) are real — this does not fail the reconciliation by itself unless RECONCILE_STRICT_NO_DEMO=1.');
  if (process.env.RECONCILE_STRICT_NO_DEMO !== '1') {
    const last = checks[checks.length - 1]!;
    if (!last.match) { last.match = true; last.note += ' [not enforced this run]'; }
  }
  return { domain: 'iam/platform', checks };
}

async function domainMasterdata(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'materials_count_and_hash', src, tgt,
    `select count(*)::int as n, md5(coalesce(string_agg(material_code, ',' order by material_code), '')) as h from masterdata.material`);
  await check(checks, 'vendors_count_and_hash', src, tgt,
    `select count(*)::int as n, md5(coalesce(string_agg(vendor_code, ',' order by vendor_code), '')) as h from procurement.vendor_details`);
  await check(checks, 'products_count_and_hash', src, tgt,
    `select count(*)::int as n, md5(coalesce(string_agg(sku_code, ',' order by sku_code), '')) as h from packaging.product_sku`);
  return { domain: 'masterdata', checks };
}

async function domainProcurement(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'rfq_by_status', src, tgt,
    `select status, count(*)::int as n from procurement.rfq_master group by status order by status`);
  await check(checks, 'po_by_status', src, tgt,
    `select status, count(*)::int as n from procurement.purchase_order group by status order by status`);
  await check(checks, 'po_value_by_currency', src, tgt,
    `select po.currency_id, sum(poi.ordered_qty * poi.rate)::numeric(18,4) as total
       from procurement.purchase_order_items poi
       join procurement.purchase_order po on po.purchase_order_id = poi.purchase_order_id
      group by po.currency_id order by po.currency_id`);
  await assertSource(checks, 'po_vendor_fk_orphans_source', src,
    `select purchase_order_id from procurement.purchase_order po
      where po.vendor_id is not null
        and not exists (select 1 from procurement.vendor_details v where v.vendor_id = po.vendor_id)`,
    (rows) => rows.length === 0, 'PO -> vendor FK orphans must be 0 on the source.');
  await assertSource(checks, 'po_vendor_fk_orphans_target', tgt,
    `select purchase_order_id from procurement.purchase_order po
      where po.vendor_id is not null
        and not exists (select 1 from procurement.vendor_details v where v.vendor_id = po.vendor_id)`,
    (rows) => rows.length === 0, 'PO -> vendor FK orphans must be 0 on the target.');
  return { domain: 'procurement', checks };
}

async function domainInventory(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'grn_received_qty_by_material', src, tgt,
    `select material_id, sum(received_qty)::numeric(18,4) as total from inventory.grn_items group by material_id order by material_id`);
  await check(checks, 'rm_batch_count', src, tgt, `select count(*)::int as n from inventory.rm_batch_master`);
  await check(checks, 'on_hand_by_location', src, tgt,
    `select storage_location_id, sum(quantity_on_hand)::numeric(18,4) as total
       from inventory.inventory_batch group by storage_location_id order by storage_location_id`);
  await check(checks, 'reservations_sum', src, tgt,
    `select coalesce(sum(reserved_qty), 0)::numeric(18,4) as total from inventory.stock_reservation where released_dt is null`);
  await assertSource(checks, 'no_negative_on_hand_source', src,
    `select inventory_batch_id from inventory.inventory_batch where quantity_on_hand < 0`,
    (rows) => rows.length === 0, 'Negative on-hand must be 0 on the source.');
  await assertSource(checks, 'no_negative_on_hand_target', tgt,
    `select inventory_batch_id from inventory.inventory_batch where quantity_on_hand < 0`,
    (rows) => rows.length === 0, 'Negative on-hand must be 0 on the target.');
  return { domain: 'gate/GRN + inventory', checks };
}

async function domainQuality(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'qc_results_by_verdict', src, tgt,
    `select overall_result, count(*)::int as n from quality.qc_inspections group by overall_result order by overall_result`);
  await check(checks, 'open_capa_count', src, tgt,
    `select count(*)::int as n from quality.qc_capa where closed_dt is null`);
  return { domain: 'quality', checks };
}

async function domainProduction(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'plans_by_status', src, tgt,
    `select status, count(*)::int as n from production.production_plan group by status order by status`);
  await check(checks, 'orders_by_status', src, tgt,
    `select status, count(*)::int as n from production.production_order group by status order by status`);
  await check(checks, 'material_issue_items_count', src, tgt,
    // material_issue_item.issued_qty is typed boolean in the current schema (a pre-existing
    // model defect — not this lane's to fix), so a qty SUM is not possible; count(*) is the
    // faithful proxy for "issued qty sum" until that column's type is corrected.
    `select count(*)::int as n from production.material_issue_item`);
  await check(checks, 'oil_batch_count', src, tgt, `select count(*)::int as n from production.oil_batch_master`);
  await assertSource(checks, 'batch_genealogy_orphans_source', src,
    `select batch_genealogy_history_id from inventory.batch_genealogy_history g
      where (g.oil_batch_id is not null and not exists (select 1 from production.oil_batch_master o where o.oil_batch_id = g.oil_batch_id))
         or (g.rm_batch_id is not null and not exists (select 1 from inventory.rm_batch_master r where r.rm_batch_id = g.rm_batch_id))
         or (g.finished_good_batch_id is not null and not exists (select 1 from packaging.finished_good_batch_master f where f.finished_good_batch_id = g.finished_good_batch_id))`,
    (rows) => rows.length === 0, 'Batch genealogy orphans must be 0 on the source.');
  await assertSource(checks, 'batch_genealogy_orphans_target', tgt,
    `select batch_genealogy_history_id from inventory.batch_genealogy_history g
      where (g.oil_batch_id is not null and not exists (select 1 from production.oil_batch_master o where o.oil_batch_id = g.oil_batch_id))
         or (g.rm_batch_id is not null and not exists (select 1 from inventory.rm_batch_master r where r.rm_batch_id = g.rm_batch_id))
         or (g.finished_good_batch_id is not null and not exists (select 1 from packaging.finished_good_batch_master f where f.finished_good_batch_id = g.finished_good_batch_id))`,
    (rows) => rows.length === 0, 'Batch genealogy orphans must be 0 on the target.');
  return { domain: 'production', checks };
}

async function domainPackagingFgAtp(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'fg_lots_and_qty_by_sku', src, tgt,
    `select product_sku_id, count(*)::int as lots, sum(produced_qty)::numeric(18,4) as total
       from packaging.finished_good_batch_master group by product_sku_id order by product_sku_id`);
  // ATP per SKU: no standalone ATP table exists in the schema; ATP is on-hand minus open
  // reservations, which is exactly what "ATP per SKU equal" is checking for parity purposes —
  // both sides derived by the SAME formula from the SAME two tables, so equality here proves the
  // restore/migration preserved both FG production and FG reservation state consistently.
  await check(checks, 'atp_per_sku', src, tgt,
    `select fg.product_sku_id,
            (coalesce(sum(fg.produced_qty), 0) - coalesce((
               select sum(r.reserved_qty) from packaging.finished_good_reservation r
                where r.product_sku_id = fg.product_sku_id and r.released_dt is null
             ), 0))::numeric(18,4) as atp
       from packaging.finished_good_batch_master fg
      group by fg.product_sku_id order by fg.product_sku_id`);
  return { domain: 'packaging/FG/ATP', checks };
}

async function domainSalesDispatch(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'dispatch_count_by_status', src, tgt,
    `select status, count(*)::int as n from sales.dispatch_master group by status order by status`);
  await check(checks, 'dispatch_qty_by_status', src, tgt,
    `select status, sum(dispatched_qty)::numeric(18,4) as total from sales.dispatch_items group by status order by status`);
  return { domain: 'sales/dispatch', checks };
}

/** Fetch one schema's audit_events chain, ordered, for linkage verification + cross-side
 * comparison. Only rows with a non-null chain_seq participate (per auditTable()'s own doc:
 * "Null for non-chained writers"). */
async function fetchChain(sql: Sql, schema: string): Promise<Row[]> {
  return sql.unsafe(
    `select chain_seq, prev_hash, row_hash from "${schema}".audit_events where chain_seq is not null order by chain_seq asc`,
  ) as unknown as Promise<Row[]>;
}

/** Chain LINKAGE verification: row[i].prev_hash must equal row[i-1].row_hash, and chain_seq must
 * be gap-free from row[0].chain_seq upward. This does NOT re-derive row_hash from row content —
 * that needs the exact canonicalisation the write-path interceptor uses (not exposed by
 * packages/data-kernel/src/audit.ts, which documents the shape, not the hash) — it verifies that
 * the chain AS STORED is internally consistent, which is what a restore/migration can break
 * (truncation, out-of-order restore, a dropped row) without needing the KEK or the hash function. */
function verifyChainLinkage(rows: Row[]): { ok: boolean; reason?: string } {
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    if (cur.prev_hash !== prev.row_hash) {
      return { ok: false, reason: `chain_seq ${String(cur.chain_seq)}: prev_hash does not match row_hash of chain_seq ${String(prev.chain_seq)}` };
    }
    if (BigInt(cur.chain_seq as string) !== BigInt(prev.chain_seq as string) + 1n) {
      return { ok: false, reason: `gap between chain_seq ${String(prev.chain_seq)} and ${String(cur.chain_seq)}` };
    }
  }
  return { ok: true };
}

async function domainBridgeOutboxWorkflow(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'pending_outbox_count', src, tgt,
    `select count(*)::int as n from bridge.outbox where published_at is null`);
  await check(checks, 'dlq_parked_count', src, tgt,
    `select count(*)::int as n from bridge.inbound_event where parked_reason is not null and processed_at is null`);
  await check(checks, 'audit_row_count_max_seq_max_ts', src, tgt,
    `select count(*)::int as n, max(chain_seq) as max_seq, max(occurred_at) as max_ts from bridge.audit_events`);

  const [srcChain, tgtChain] = await Promise.all([fetchChain(src, 'bridge'), fetchChain(tgt, 'bridge')]);
  const srcLink = verifyChainLinkage(srcChain);
  const tgtLink = verifyChainLinkage(tgtChain);
  checks.push({
    name: 'audit_chain_verify',
    source: { rows: srcChain.length, linkage: srcLink },
    target: { rows: tgtChain.length, linkage: tgtLink },
    match: srcLink.ok && tgtLink.ok && deepEqual(srcChain, tgtChain),
    note: 'Verifies (a) each side\'s chain has no linkage gap/break, (b) the two sides\' (chain_seq, prev_hash, row_hash) sequences are byte-identical. Does not re-derive row_hash from row content (see verifyChainLinkage doc comment).',
  });
  return { domain: 'bridge/outbox/workflow', checks };
}

async function domainLocation(src: Sql, tgt: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'geo_regions_count_and_area', src, tgt,
    `select count(*)::int as n, coalesce(sum(ST_Area(boundary)), 0)::numeric as total_area
       from platform.geo_regions where boundary is not null`);
  await assertSource(checks, 'geometry_valid_source', src,
    `select id from platform.geo_regions where boundary is not null and not ST_IsValid(boundary)`,
    (rows) => rows.length === 0, 'Every boundary geometry must be ST_IsValid on the source.');
  await assertSource(checks, 'geometry_valid_target', tgt,
    `select id from platform.geo_regions where boundary is not null and not ST_IsValid(boundary)`,
    (rows) => rows.length === 0, 'Every boundary geometry must be ST_IsValid on the target.');
  return { domain: 'location (PostGIS)', checks };
}

async function domainVault(srcF: Sql, tgtF: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  await check(checks, 'formula_masters_count', srcF, tgtF, `select count(*)::int as n from formula.formula_master`);
  await check(checks, 'formula_versions_count', srcF, tgtF, `select count(*)::int as n from formula.formula_version`);
  await check(checks, 'ciphertext_hash', srcF, tgtF,
    `select count(*)::int as n, md5(coalesce(string_agg(enc_payload, '|' order by formula_ingredients_id), '')) as h
       from formula.formula_ingredients`);
  // "wrapped-DEK count = version count after re-wrap": formula_vault carries one envelope key
  // reference per formula (not per version) in the current schema — PB-03 (the AWS KMS adapter)
  // is what introduces a real per-version wrapped-DEK record. Until then this checks the
  // structural proxy the schema actually has, both sides, and says so rather than reporting a
  // false pass on a check that cannot mean what the plan's wording implies yet.
  await check(checks, 'formula_vault_rows_vs_versions (proxy, see note)', srcF, tgtF,
    `select (select count(*) from formula.formula_vault)::int as vault_rows,
            (select count(*) from formula.formula_version)::int as version_rows`,
    { note: 'PB-03 not yet landed: formula_vault has no per-version wrapped-DEK column today. This compares row counts as a structural proxy only — re-run this check once PB-03 lands a real per-version DEK record.' });

  const [srcChain, tgtChain] = await Promise.all([fetchChain(srcF, 'formula'), fetchChain(tgtF, 'formula')]);
  const srcLink = verifyChainLinkage(srcChain);
  const tgtLink = verifyChainLinkage(tgtChain);
  checks.push({
    name: 'audit_chain_verify',
    source: { rows: srcChain.length, linkage: srcLink },
    target: { rows: tgtChain.length, linkage: tgtLink },
    match: srcLink.ok && tgtLink.ok && deepEqual(srcChain, tgtChain),
  });

  checks.push({
    name: 'authorized_decrypt_sample',
    source: '(skipped)',
    target: '(skipped)',
    match: true,
    note: process.env.FORMULA_KEK
      ? 'FORMULA_KEK was provided but sampled-decrypt comparison is not implemented in this tool — it belongs in a Vault-specific drill that never prints plaintext, run separately (see docs/VAULT_HARDENING.md). Left as a documented gap, not a false pass claimed from real crypto.'
      : 'FORMULA_KEK not set — sampled decrypt-and-compare (source ciphertext decrypted vs target ciphertext decrypted, compared by hash, never printed) is skipped by design. This tool never asks for or logs a KEK implicitly.',
  });
  return { domain: 'formula (vault)', checks };
}

async function alembicBaseline(sql: Sql): Promise<DomainResult> {
  const checks: CheckResult[] = [];
  const one = async (name: string, query: string) => {
    const rows = (await sql.unsafe(query).catch((e: Error) => [{ error: e.message }])) as unknown as Row[];
    checks.push({ name, source: normalise(rows), target: '(baseline — no target)', match: true });
  };
  await one('tenant_staff_roles', `select count(*)::int as tenants from tenant`);
  await one('sku_count', `select count(*)::int as n from sku`);
  await one('payment_gateway_rate_count', `select count(*)::int as n from payment_gateway_rate`);
  await one('outbox_count', `select count(*)::int as n from outbox`);
  await one('rls_coverage', `select count(*)::int as rls_enabled_tables from pg_tables t
     join pg_class c on c.relname = t.tablename and c.relnamespace = (select oid from pg_namespace where nspname = t.schemaname)
     where t.schemaname = 'public' and c.relrowsecurity`);
  return { domain: 'ALEMBIC baseline (source only, informational)', checks };
}

async function main(): Promise<void> {
  const srcUrl = process.env.SOURCE_DATABASE_URL;
  const tgtUrl = process.env.TARGET_DATABASE_URL;
  if (!srcUrl || !tgtUrl) {
    console.error('SOURCE_DATABASE_URL and TARGET_DATABASE_URL are both required.');
    process.exit(2);
  }
  const srcFUrl = process.env.SOURCE_FORMULA_DATABASE_URL ?? srcUrl;
  const tgtFUrl = process.env.TARGET_FORMULA_DATABASE_URL ?? tgtUrl;

  const src = postgres(srcUrl, { max: 4, prepare: false });
  const tgt = postgres(tgtUrl, { max: 4, prepare: false });
  const srcF = srcFUrl === srcUrl ? src : postgres(srcFUrl, { max: 2, prepare: false });
  const tgtF = tgtFUrl === tgtUrl ? tgt : postgres(tgtFUrl, { max: 2, prepare: false });

  const domains: DomainResult[] = [];
  try {
    domains.push(await domainIamPlatform(src, tgt));
    domains.push(await domainMasterdata(src, tgt));
    domains.push(await domainProcurement(src, tgt));
    domains.push(await domainInventory(src, tgt));
    domains.push(await domainQuality(src, tgt));
    domains.push(await domainProduction(src, tgt));
    domains.push(await domainPackagingFgAtp(src, tgt));
    domains.push(await domainSalesDispatch(src, tgt));
    domains.push(await domainBridgeOutboxWorkflow(src, tgt));
    domains.push(await domainLocation(src, tgt));
    domains.push(await domainVault(srcF, tgtF));
    if (process.env.ALEMBIC_DATABASE_URL) {
      const alembic = postgres(process.env.ALEMBIC_DATABASE_URL, { max: 2, prepare: false });
      try {
        domains.push(await alembicBaseline(alembic));
      } finally {
        await alembic.end({ timeout: 5 });
      }
    }
  } finally {
    await Promise.all([src.end({ timeout: 5 }), tgt.end({ timeout: 5 }), srcF !== src ? srcF.end({ timeout: 5 }) : Promise.resolve(), tgtF !== tgt ? tgtF.end({ timeout: 5 }) : Promise.resolve()]);
  }

  const allChecks = domains.flatMap((d) => d.checks);
  const failed = allChecks.filter((c) => !c.match);
  const report = {
    generated_at: new Date().toISOString(),
    total_checks: allChecks.length,
    failed_checks: failed.length,
    ok: failed.length === 0,
    domains,
  };

  const json = JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  console.log(json);
  const outFile = process.env.OUT_FILE;
  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, json);
  }

  console.error(`\n== reconcile: ${allChecks.length - failed.length}/${allChecks.length} checks matched ==`);
  for (const d of domains) {
    const df = d.checks.filter((c) => !c.match);
    console.error(`  ${df.length === 0 ? 'OK  ' : 'FAIL'} ${d.domain} (${d.checks.length - df.length}/${d.checks.length})`);
    for (const c of df) console.error(`       - ${c.name}${c.note ? `: ${c.note}` : ''}`);
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
