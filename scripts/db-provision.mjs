/**
 * db:provision — one idempotent command that provisions a FRESH console database from empty, in
 * the correct order. This is the reproducibility fix (audit H-R): standing up a new (e.g. offline)
 * console is now a single step instead of a hand-run sequence that silently omitted ad-hoc tables.
 *
 *   DATABASE_URL=... [FORMULA_DATABASE_URL=...] pnpm db:provision
 *
 * Order: db:push (all schema-as-code tables) → standalone CREATE scripts for tables that live
 * outside db:push (db:push skips already-populated schemas, so late-added tables ship as scripts)
 * → RBAC seed → demo data. Schema steps are REQUIRED (abort on failure); data seeds are best-effort
 * (a fresh console must BOOT even if demo data is skipped). Re-running is safe (all steps idempotent
 * or CREATE/INSERT-IF-NOT-EXISTS).
 */
import { execSync } from 'node:child_process';

const REQUIRED = [
  ['schema: db:push (all clusters)', 'pnpm db:push'],
  ['table: notification_log', 'node scripts/create-notification-log-table.cjs'],
  ['table: document_registry', 'node scripts/create-document-registry-table.cjs'],
  ['table: packaging_qc', 'node scripts/create-packaging-qc-table.cjs'],
  ['table: finished_good_reservation', 'node scripts/create-finished-good-reservation-table.cjs'],
  ['tables: relay_*', 'node scripts/create-relay-tables.cjs'],
  ['tables: ad-hoc (negotiation/advance/dispatch/approval-matrix/dispatch-document + PO column)', 'node scripts/create-adhoc-tables.cjs'],
  ['table: material_issue_applied (consumption ledger + backfill)', 'node scripts/create-material-issue-applied-table.cjs'],
  ['guard: formula.audit_events append-only trigger', 'node scripts/create-vault-audit-guard.cjs'],
  ['seed: RBAC (roles + permissions)', 'pnpm db:seed'],
];
const OPTIONAL = [
  ['data: domain demo data', 'pnpm db:seed:data'],
  ['data: org units', 'node scripts/seed-org.cjs'],
  ['data: screens', 'node scripts/seed-screens.cjs'],
  ['data: flow gaps', 'node scripts/seed-flow-gaps.cjs'],
  ['data: trace links', 'node scripts/seed-trace-links.cjs'],
  ['data: approval matrix (35 rows)', 'node scripts/seed-approval-matrix.cjs'],
  // Portal-audit WS6: runs LAST so the org/warehouse/user parents from the seeds above exist —
  // fills the empty country/location-type/business-unit/floor/bin masters + wires null hierarchy
  // FKs + backfills user employee_code/mobile_number.
  ['data: master hierarchy (countries/BUs/location-types/floors/bins + wiring)', 'node scripts/seed-master-hierarchy.cjs'],
  // WS8: fill uom_id on quantity rows so the UI shows units (kg/L/ml/pcs), not bare numbers.
  ['data: unit-of-measure backfill (materials + quantity rows)', 'node scripts/backfill-uom.cjs'],
];

function run(name, cmd, required) {
  console.log(`\n▶ ${name}\n  ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', env: process.env });
  } catch (e) {
    if (required) { console.error(`\n✗ REQUIRED step failed: ${name} — aborting.`); process.exit(1); }
    console.warn(`  ⚠ optional step failed (${name}) — continuing.`);
  }
}

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(1); }
console.log('== db:provision — fresh console database ==');
for (const [n, c] of REQUIRED) run(n, c, true);
for (const [n, c] of OPTIONAL) run(n, c, false);
console.log('\n✓ provision complete — the console can boot.');
