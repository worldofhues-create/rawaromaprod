/**
 * Lane F5 (RP-DEADTABLES) — permanent guard against "dead table" defects: backend SQL/drizzle
 * that references a Postgres relation `pnpm db:push` will never create.
 *
 * BACKGROUND: `pnpm db:push` (scripts/db-push.ts + scripts/db-schema-groups.ts) builds every real
 * schema EXCLUSIVELY from the drizzle table definitions under packages/data-<cluster>/src/schema — that
 * is the single source of truth for what exists in any real/dev database. Lane F3 found that
 * procurement.vendor_negotiation and procurement.vendor_dispatch were referenced by raw SQL in
 * backend/ despite never being defined there (commit db4815f); lane F5 swept the rest of
 * backend/ mechanically and found six more (see KNOWN_DEBT below). Each 500s "relation does not
 * exist" on a real database the instant it runs.
 *
 * MECHANISM: this test (1) extracts every `<schema>.table("<name>", ...)` call from every .ts
 * file under each packages/data-<cluster>/src/schema directory — the exact same shape
 * scripts/db-push.ts imports from, including the @core/data-kernel auditTable()/outboxTable()
 * factories, which every cluster schema calls for its `outbox` and `audit_events` tables — then
 * (2) greps every `.ts` file under backend/
 * (excluding tests and this file's own support directory) for `from|join|into|update
 * <schema>.<table>` after stripping comments, and (3) fails if any such reference names a table
 * that is in NEITHER the real set NOR the KNOWN_DEBT allowlist below.
 *
 * KNOWN_DEBT is deliberately explicit, with a reason for each entry (which route/service uses
 * it and why it wasn't fixed in this lane), so:
 *   - a NEW dead-table reference anywhere in backend/ fails the build immediately (this is the
 *     guard's whole point — the list can only ever shrink, never grow silently);
 *   - fixing a listed table's route (adding a dictionary entry + db:push, or converting the route
 *     to an honest NotImplementedException + removing the raw SQL) is IMMEDIATELY visible: the
 *     "no longer referenced" check below fails and tells you to delete the stale entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

/**
 * Tables genuinely missing from every db:push source, kept ONLY because fixing them safely needs
 * either a Phase-1A Data Dictionary addition (owner-locked, out of this lane's authority per
 * CLAUDE.md C3) or — for material_issue_applied/packaging_qc — a larger redesign than a route-
 * level stub, because they're woven into working transactional flows, not a dead-end route:
 *
 *   iam.login_history            — cluster-org/src/auth/auth.service.ts#recordSession, a
 *                                   best-effort/try-caught write on every login (does not block
 *                                   login on failure). The READ side (AuditService.loginHistory)
 *                                   was already converted to NotImplementedException by lane F5.
 *   inventory.material_issue_applied
 *                                 — the single-applier concurrency claim shared between
 *                                   ConsumptionService.applyIssue (outbox poller) and
 *                                   MixingService.abortSession, guarding real inventory debit/
 *                                   credit races. Not a standalone route: converting it to a stub
 *                                   would silently corrupt the abort-vs-debit race instead of
 *                                   just refusing a request. Needs the table in the dictionary +
 *                                   @ra/data-inventory before either caller can be real.
 *   packaging.packaging_qc       — a cross-cluster QC gate read by packaging-lookup, reservation,
 *                                   cluster-sales dispatch, fg-stock, dashboard, AND the dedicated
 *                                   packaging-qc CRUD route. Six call sites across four clusters;
 *                                   not a single dead-end service. Needs the table in the
 *                                   dictionary + @ra/data-packaging.
 *   platform.document_registry   — the DocumentsService CRUD route + edit.service.ts entry were
 *                                   converted to NotImplementedException by lane F5. One reference
 *                                   remains: EmailNotifierService.scan()'s document-expiry digest,
 *                                   isolated in its own try/catch (lane F5) so it can't take down
 *                                   the other, real, digest/escalation checks in the same scan.
 *   platform.notification_log    — EmailNotifierService.drain()/deliver() (the primary
 *                                   event-driven notifier — deliver()'s insert is the one write
 *                                   that decides whether an email "sent" for real), the dead-
 *                                   letter digest in scan() (isolated, lane F5), and
 *                                   cluster-inventory/grn.service.ts's vendor-variance notice
 *                                   (already try-caught as best-effort, "must not roll back the
 *                                   receipt"). drain()'s own dedup query depends on this table
 *                                   directly, so the ENTIRE event-driven notifier is dead on any
 *                                   real database, not just the digest — this needs the table in
 *                                   the dictionary + @ra/data-reference (or a redesigned dedup
 *                                   strategy) before it can be fixed for real.
 *
 * To make a feature real: add the table to docs/PHASE1A_SCHEMA_PLAN.md (owner-approved) + the
 * matching packages/data-<cluster>/src/schema file, run `pnpm db:push`, delete the raw-SQL call sites'
 * NotImplementedException guard (for the relay, restore relay.service.ts from integration/fullsystem@db4815f),
 * and delete that table's line below — the guard test will then tell you if any reference to it
 * remains unaccounted for.
 */
const KNOWN_DEBT: ReadonlySet<string> = new Set([
  'iam.login_history',
  'inventory.material_issue_applied',
  'packaging.packaging_qc',
  'platform.document_registry',
  'platform.notification_log',
]);

/** Recursively list files under `dir` whose path matches `pred`, skipping node_modules/dist. */
function walk(dir: string, pred: (p: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, pred, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

/** Every `<schemaVar>.table("<name>", ...)` call across packages/data-<cluster>/src/schema — the exact
 * shape scripts/db-push.ts imports from (via scripts/db-schema-groups.ts's SCHEMA_GROUPS). The
 * schema var name is always the real pg schema name (verified: every `pgSchema("<name>")` call
 * assigns to a const of that same name — see each package's src/schema/_schema.ts). */
function realTables(): Set<string> {
  const tables = new Set<string>();
  const packagesDir = join(repoRoot, 'packages');
  for (const entry of readdirSync(packagesDir)) {
    if (!entry.startsWith('data-')) continue;
    const schemaDir = join(packagesDir, entry, 'src', 'schema');
    let files: string[];
    try {
      files = walk(schemaDir, (p) => p.endsWith('.ts'));
    } catch {
      continue; // no src/schema dir (e.g. a non-drizzle package)
    }
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const re = /([a-zA-Z0-9_]+)\.table\(\s*\n?\s*"([a-zA-Z0-9_]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) tables.add(`${m[1]}.${m[2]}`);
    }
  }
  // The @core/data-kernel auditTable()/outboxTable() factories build `<schema>.outbox` and
  // `<schema>.audit_events` for every cluster's crosscutting.ts (auditTable(schema) /
  // outboxTable(schema) called with each schema's own pgSchema instance) — these don't match the
  // literal-string regex above because the factory's internal `schema.table("outbox"/
  // "audit_events", ...)` call sees a `schema` PARAMETER, not the imported const. Every schema
  // var name found above is a real cluster schema, so both cross-cutting tables exist for each.
  const schemas = new Set([...tables].map((t) => t.split('.')[0]));
  for (const s of schemas) {
    tables.add(`${s}.outbox`);
    tables.add(`${s}.audit_events`);
  }
  return tables;
}

/** endpoint-style `schema.table` references in backend/ SQL (raw template literals / .unsafe /
 * EditService's `${cfg.schema}.${cfg.table}`-style identifiers written as literal strings) and
 * drizzle-adjacent code, found via `from|join|into|update <schema>.<table>` after stripping
 * comments (so doc comments describing a table, like this file's own KNOWN_DEBT rationale, or
 * F3/F5's "used to query X" notes, are never mistaken for a live reference). */
function backendReferences(): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>(); // "schema.table" -> set of relative file paths
  const backendDir = join(repoRoot, 'backend');
  const files = walk(
    backendDir,
    (p) => p.endsWith('.ts') && !p.includes(`${join('backend', 'test-support')}`) && !/__tests__/.test(p) && !p.endsWith('.test.ts'),
  );
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const re = /\b(?:from|join|into|update)\s+([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped))) {
      const key = `${m[1]}.${m[2]}`;
      const rel = f.slice(repoRoot.length + 1);
      if (!refs.has(key)) refs.set(key, new Set());
      refs.get(key)!.add(rel);
    }
  }
  return refs;
}

test('schema guard: every backend SQL table reference exists in the real db:push schema sources, or is explicit KNOWN_DEBT', () => {
  const real = realTables();
  const refs = backendReferences();
  const clusterSchemas = new Set([...real].map((t) => t.split('.')[0]));

  const violations: string[] = [];
  for (const [key, files] of refs) {
    const [schema] = key.split('.');
    if (!clusterSchemas.has(schema)) continue; // not a cluster-schema reference (e.g. information_schema, pg_catalog)
    if (real.has(key)) continue;
    if (KNOWN_DEBT.has(key)) continue;
    violations.push(`${key} — referenced by: ${[...files].sort().join(', ')}`);
  }

  assert.deepEqual(
    violations,
    [],
    'Found backend SQL referencing a table that does not exist in packages/data-<cluster>/src/schema ' +
      '(pnpm db:push\'s only source) and is not in this test\'s KNOWN_DEBT allowlist. Either fix ' +
      'the reference (typo/rename), convert the route to an honest NotImplementedException, or — ' +
      'if it genuinely needs a new table — get it added to docs/PHASE1A_SCHEMA_PLAN.md and add it ' +
      'to KNOWN_DEBT here with a reason:\n' + violations.join('\n'),
  );
});

test('schema guard: KNOWN_DEBT has no stale entries — every listed table is still actually referenced', () => {
  const refs = backendReferences();
  const stale = [...KNOWN_DEBT].filter((key) => !refs.has(key));
  assert.deepEqual(
    stale,
    [],
    'These KNOWN_DEBT entries are no longer referenced anywhere in backend/ — the fix landed, ' +
      'delete them from the allowlist above so the list keeps shrinking:\n' + stale.join('\n'),
  );
});
