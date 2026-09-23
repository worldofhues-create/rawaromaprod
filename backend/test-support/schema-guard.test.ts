/**
 * Lane F5 (RP-DEADTABLES) — permanent guard against "dead table" defects: backend SQL/drizzle
 * that references a Postgres relation `pnpm db:push` will never create. Extended by lane B1
 * (live testing found `GET /v1/purchase-orders` 500ing on a missing COLUMN, not a missing table —
 * the original table-only guard below would never have caught it) to also check COLUMN
 * references, not just table references — see COLUMN_KNOWN_DEBT and the second pair of tests.
 *
 * BACKGROUND: `pnpm db:push` (scripts/db-push.ts + scripts/db-schema-groups.ts) builds every real
 * schema EXCLUSIVELY from the drizzle table definitions under packages/data-<cluster>/src/schema — that
 * is the single source of truth for what exists in any real/dev database. Lane F3 found that
 * procurement.vendor_negotiation and procurement.vendor_dispatch were referenced by raw SQL in
 * backend/ despite never being defined there (commit db4815f); lane F5 swept the rest of
 * backend/ mechanically and found six more (see KNOWN_DEBT below; lane B1 later adopted
 * `packaging.packaging_qc` for real — packages/data-packaging/src/schema/qc.ts — so it no longer
 * appears there). Each 500s "relation does not exist" on a real database the instant it runs.
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
 * CLAUDE.md C3) or — for material_issue_applied — a larger redesign than a route-level stub,
 * because it's woven into a working transactional flow, not a dead-end route:
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

/** Return the source text of the balanced `{ ... }` block starting at/after `fromIdx`. */
function extractBraceBlock(text: string, fromIdx: number): string | null {
  const start = text.indexOf('{', fromIdx);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Static column sets for the two @core/data-kernel column-group factories/helpers every cluster
// schema spreads or calls (see that comment further down for why the table-detection regex can't
// see them directly).
const OUTBOX_COLUMNS = ['id', 'type', 'payload', 'aggregate_id', 'occurred_at', 'published_at', 'attempts', 'seq'];
const AUDIT_EVENTS_COLUMNS = [
  'id', 'actor_id', 'action', 'entity_type', 'entity_id', 'before', 'after', 'request_id', 'ip',
  'occurred_at', 'chain_seq', 'prev_hash', 'row_hash',
];
// packages/data-kernel/src/columns.ts's spread helpers — `...metaColumns()` is on every Phase-1A
// dictionary table; `...baseColumns()`/`...softDelete()` are the (older) @core template helpers.
const META_COLUMNS = ['status', 'created_dt', 'updated_dt', 'created_by', 'updated_by'];
const BASE_COLUMNS = ['id', 'created_at', 'updated_at', 'created_by', 'updated_by'];
const SOFT_DELETE_COLUMNS = ['deleted_at'];

/** Every `<schemaVar>.table("<name>", ...)` call across packages/data-<cluster>/src/schema — the exact
 * shape scripts/db-push.ts imports from (via scripts/db-schema-groups.ts's SCHEMA_GROUPS). The
 * schema var name is always the real pg schema name (verified: every `pgSchema("<name>")` call
 * assigns to a const of that same name — see each package's src/schema/_schema.ts). Returns
 * "schema.table" -> the set of real (snake_case) column names on that table, parsed from each
 * column builder's first string-literal argument (`fieldName: varchar("col_name", ...)` etc.),
 * plus the `...metaColumns()`/`...baseColumns()`/`...softDelete()` spreads (data-kernel's
 * column-group helpers, which the same per-column regex can't see since they add no literal
 * string arg at the call site) expanded from their known static shape. */
function realTablesAndColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
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
      while ((m = re.exec(text))) {
        const key = `${m[1]}.${m[2]}`;
        const cols = tables.get(key) ?? new Set<string>();
        const block = extractBraceBlock(text, re.lastIndex);
        if (block) {
          const colRe = /[A-Za-z0-9_]+\s*:\s*[A-Za-z0-9_.]+\(\s*"([a-z][a-z0-9_]*)"/g;
          let cm: RegExpExecArray | null;
          while ((cm = colRe.exec(block))) cols.add(cm[1]);
          if (/\.\.\.metaColumns\(\)/.test(block)) META_COLUMNS.forEach((c) => cols.add(c));
          if (/\.\.\.baseColumns\(\)/.test(block)) BASE_COLUMNS.forEach((c) => cols.add(c));
          if (/\.\.\.softDelete\(\)/.test(block)) SOFT_DELETE_COLUMNS.forEach((c) => cols.add(c));
        }
        tables.set(key, cols);
      }
    }
  }
  // The @core/data-kernel auditTable()/outboxTable() factories build `<schema>.outbox` and
  // `<schema>.audit_events` for every cluster's crosscutting.ts (auditTable(schema) /
  // outboxTable(schema) called with each schema's own pgSchema instance) — these don't match the
  // literal-string regex above because the factory's internal `schema.table("outbox"/
  // "audit_events", ...)` call sees a `schema` PARAMETER, not the imported const. Every schema
  // var name found above is a real cluster schema, so both cross-cutting tables exist for each.
  const schemas = new Set([...tables.keys()].map((t) => t.split('.')[0]));
  for (const s of schemas) {
    tables.set(`${s}.outbox`, new Set(OUTBOX_COLUMNS));
    tables.set(`${s}.audit_events`, new Set(AUDIT_EVENTS_COLUMNS));
  }
  return tables;
}

/** SQL keywords that can follow a `schema.table` reference where an alias would otherwise go —
 * excluded so e.g. `from procurement.purchase_order where ...` doesn't register `where` as an
 * alias for purchase_order. */
const SQL_KEYWORDS = new Set([
  'where', 'on', 'order', 'group', 'limit', 'left', 'right', 'inner', 'join', 'and', 'or', 'as',
  'set', 'values', 'returning', 'select', 'from', 'into', 'update', 'insert', 'delete', 'having',
  'union', 'not', 'null', 'is', 'in', 'desc', 'asc', 'distinct',
]);

interface BackendRefs {
  /** "schema.table" -> set of relative file paths referencing the table at all. */
  tables: Map<string, Set<string>>;
  /** "schema.table" -> column name -> set of relative file paths referencing that column. */
  columns: Map<string, Map<string, Set<string>>>;
}

/** endpoint-style `schema.table` (and, within each SQL statement, `alias.column`/`insert into
 * schema.table (cols)`/`update schema.table set col = `) references in backend/ SQL (raw template
 * literals / .unsafe) and drizzle-adjacent code, found by (1) stripping comments, (2) splitting
 * each file into its backtick-delimited template-literal scopes (each raw SQL statement is
 * self-contained inside one), and (3) per scope, mapping `from|join|into|update schema.table
 * [alias]` to build an alias->table map (the table's own name is always a valid qualifier too),
 * then matching `alias.column` against that map. Column refs via a derived-table alias (e.g. a
 * `(select ...) x` subquery) are invisible to this (no `schema.table` precedes `x`) — this is a
 * heuristic sweep, not a SQL parser; it undercounts rather than false-positives. */
function backendReferences(): BackendRefs {
  const tableRefs = new Map<string, Set<string>>();
  const columnRefs = new Map<string, Map<string, Set<string>>>();
  const addColumnRef = (key: string, col: string, rel: string) => {
    if (!columnRefs.has(key)) columnRefs.set(key, new Map());
    const m = columnRefs.get(key)!;
    if (!m.has(col)) m.set(col, new Set());
    m.get(col)!.add(rel);
  };

  const backendDir = join(repoRoot, 'backend');
  const files = walk(
    backendDir,
    (p) => p.endsWith('.ts') && !p.includes(`${join('backend', 'test-support')}`) && !/__tests__/.test(p) && !p.endsWith('.test.ts'),
  );
  for (const f of files) {
    const rel = f.slice(repoRoot.length + 1);
    const text = readFileSync(f, 'utf8');
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // Table-level (whole file, matches the original F5 behaviour exactly).
    const tblRe = /\b(?:from|join|into|update)\s+([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tblRe.exec(stripped))) {
      const key = `${tm[1]}.${tm[2]}`;
      if (!tableRefs.has(key)) tableRefs.set(key, new Set());
      tableRefs.get(key)!.add(rel);
    }

    // Column-level (per raw-SQL template-literal scope, so an alias never leaks across queries).
    const scopes = stripped.match(/`[^`]*`/g) ?? [];
    for (const scopeRaw of scopes) {
      const scope = scopeRaw.slice(1, -1);
      const aliasMap = new Map<string, string>();
      const scopeTblRe = /\b(?:from|join|into|update)\s+([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
      let sm: RegExpExecArray | null;
      let anyTable = false;
      while ((sm = scopeTblRe.exec(scope))) {
        anyTable = true;
        const key = `${sm[1]}.${sm[2]}`;
        aliasMap.set(sm[2], key); // the table's own name always qualifies
        if (sm[3] && !SQL_KEYWORDS.has(sm[3].toLowerCase())) aliasMap.set(sm[3], key);
      }
      if (!anyTable) continue;

      const colRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
      let cm: RegExpExecArray | null;
      while ((cm = colRe.exec(scope))) {
        const key = aliasMap.get(cm[1]);
        if (!key) continue; // not a known alias in this scope (derived table, unrelated dotted ref, ...)
        addColumnRef(key, cm[2], rel);
      }

      const insRe = /insert\s+into\s+([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/gi;
      let im: RegExpExecArray | null;
      while ((im = insRe.exec(scope))) {
        const key = `${im[1]}.${im[2]}`;
        for (const col of im[3].split(',').map((c) => c.trim())) {
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) addColumnRef(key, col, rel);
        }
      }

      const updRe = /update\s+([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s+set\s+([\s\S]*?)(?:where|returning|;|$)/gi;
      let um: RegExpExecArray | null;
      while ((um = updRe.exec(scope))) {
        const key = `${um[1]}.${um[2]}`;
        const assignRe = /(?:^|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;
        let am: RegExpExecArray | null;
        while ((am = assignRe.exec(um[3]))) addColumnRef(key, am[1], rel);
      }
    }
  }
  return { tables: tableRefs, columns: columnRefs };
}

test('schema guard: every backend SQL table reference exists in the real db:push schema sources, or is explicit KNOWN_DEBT', () => {
  const real = realTablesAndColumns();
  const refs = backendReferences();
  const clusterSchemas = new Set([...real.keys()].map((t) => t.split('.')[0]));

  const violations: string[] = [];
  for (const [key, files] of refs.tables) {
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
  const stale = [...KNOWN_DEBT].filter((key) => !refs.tables.has(key));
  assert.deepEqual(
    stale,
    [],
    'These KNOWN_DEBT entries are no longer referenced anywhere in backend/ — the fix landed, ' +
      'delete them from the allowlist above so the list keeps shrinking:\n' + stale.join('\n'),
  );
});

/**
 * Columns genuinely missing from a real table's db:push source. Empty right now (lane B1 fixed
 * the one known drift — procurement.purchase_order.replacement_of_po_id, the "Generate
 * replacement PO" flow off a rejected GRN, po.service.ts#createReplacementPo /
 * procanalytics.service.ts#createReplacementPo — by adding the column for real, see
 * packages/data-procurement/src/schema/po.ts). Kept as a named allowlist (not just an empty
 * assertion) so the NEXT column-level drift has an obvious place to land with a reason, same
 * shape as KNOWN_DEBT above. Only checked for tables that ARE real — a column on a KNOWN_DEBT
 * (nonexistent) table is already reported by the table-level test above and would just be noise
 * here.
 */
const COLUMN_KNOWN_DEBT: ReadonlySet<string> = new Set([]);

test('schema guard: every backend SQL column reference exists on the real db:push table, or is explicit COLUMN_KNOWN_DEBT', () => {
  const real = realTablesAndColumns();
  const refs = backendReferences();

  const violations: string[] = [];
  for (const [table, colMap] of refs.columns) {
    const cols = real.get(table);
    if (!cols) continue; // table itself missing/KNOWN_DEBT — covered by the table-level test
    for (const [col, files] of colMap) {
      const key = `${table}.${col}`;
      if (cols.has(col)) continue;
      if (COLUMN_KNOWN_DEBT.has(key)) continue;
      violations.push(`${key} — referenced by: ${[...files].sort().join(', ')}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    'Found backend SQL referencing a column that does not exist on its table in ' +
      'packages/data-<cluster>/src/schema (pnpm db:push\'s only source) and is not in this ' +
      'test\'s COLUMN_KNOWN_DEBT allowlist. Either fix the reference (typo/rename) or add the ' +
      'column to the matching packages/data-<cluster>/src/schema file (proper FK/type, additive ' +
      'only) — this is exactly the RP-B1 defect class (purchase_order.replacement_of_po_id was ' +
      'used by raw SQL for months without ever being in the drizzle schema, 500ing ' +
      'GET /v1/purchase-orders on any real database):\n' + violations.join('\n'),
  );
});

test('schema guard: COLUMN_KNOWN_DEBT has no stale entries — every listed column is still actually referenced', () => {
  const refs = backendReferences();
  const stale = [...COLUMN_KNOWN_DEBT].filter((key) => {
    const [schema, table, col] = key.split('.');
    const files = refs.columns.get(`${schema}.${table}`)?.get(col);
    return !files || files.size === 0;
  });
  assert.deepEqual(
    stale,
    [],
    'These COLUMN_KNOWN_DEBT entries are no longer referenced anywhere in backend/ — the fix ' +
      'landed, delete them from the allowlist above so the list keeps shrinking:\n' + stale.join('\n'),
  );
});
