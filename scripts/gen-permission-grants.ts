/**
 * Additive IAM grant SQL for a release: what `scripts/db-seed.ts` WOULD add to an already-seeded
 * database, without running the seed. The seed is for bootstrapping a fresh database only. It also
 * resets the owner's password hash and needs bootstrap secrets, so production never re-runs it.
 * A release that adds permissions applies this file's output instead.
 *
 * It reads the same catalogue the seed reads (scripts/ra-permissions.ts RA_PERMISSIONS +
 * scripts/ra-roles.ts CAPABILITY_PERMISSIONS, and each RoleDef.select), and compares it with the
 * same two files at a git ref (what production was last seeded or granted from):
 *
 *   - a permission code that is new since the ref     -> insert into iam.permission_master
 *   - a role that is new since the ref                -> insert into iam.role_master
 *   - a (role, permission) grant that is new since it -> insert into iam.role_permission_mapping
 *   - a grant that was REMOVED since the ref          -> printed as a comment only, never revoked
 *
 * Every statement is guarded with NOT EXISTS, so applying the output twice is a no-op, and the
 * whole file runs in one transaction. It refuses (exit 1, no output) if any resulting grant would
 * break one of the seed's hard invariants (§107/§108/§109.7/§113, G1/PB-08, LANE D1).
 *
 *   pnpm exec tsx scripts/gen-permission-grants.ts --since <git-ref> [--out <file>]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RA_PERMISSIONS } from './ra-permissions.js';
import * as current from './ra-roles.js';

type RolesModule = typeof current;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Load ra-permissions.ts + ra-roles.ts as they were at `ref`. */
async function loadAt(ref: string): Promise<{ codes: string[]; roles: RolesModule['ROLES'] }> {
  const dir = mkdtempSync(join(tmpdir(), 'ra-grants-'));
  try {
    for (const f of ['ra-permissions.ts', 'ra-roles.ts']) {
      writeFileSync(join(dir, f), execFileSync('git', ['show', `${ref}:scripts/${f}`], { cwd: ROOT, encoding: 'utf8' }));
    }
    const perms = (await import(pathToFileURL(join(dir, 'ra-permissions.ts')).href)) as { RA_PERMISSIONS: string[] };
    const roles = (await import(pathToFileURL(join(dir, 'ra-roles.ts')).href)) as Partial<RolesModule>;
    return { codes: [...perms.RA_PERMISSIONS, ...(roles.CAPABILITY_PERMISSIONS ?? [])], roles: roles.ROLES ?? [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The seed's grantRole() refusals (scripts/db-seed.ts), over one role's full grant set. */
function violations(role: string, granted: string[]): string[] {
  const m = current;
  const out: string[] = [];
  const has = (c: string) => granted.includes(c);
  if (!m.VAULT_PLAINTEXT_ROLES.includes(role) && has(m.VAULT_PLAINTEXT_PERMISSION)) out.push(m.VAULT_PLAINTEXT_PERMISSION);
  if (!m.PLATFORM_OPS_ROLES.includes(role) && has(m.PLATFORM_OPS_PERMISSION)) out.push(m.PLATFORM_OPS_PERMISSION);
  if (!m.ROLE_GRANTERS.includes(role) && has(m.ROLE_GRANT_PERMISSION)) out.push(m.ROLE_GRANT_PERMISSION);
  if (!m.VAULT_PLAINTEXT_ROLES.includes(role)) out.push(...granted.filter((c) => m.FORMULA_DECISION_PERMISSIONS.has(c)));
  if (role === 'formulator') out.push(...granted.filter((c) => m.FORMULATOR_FORBIDDEN_PERMISSIONS.has(c)));
  if (role === 'vault_approver') out.push(...granted.filter((c) => m.VAULT_APPROVER_FORBIDDEN_PERMISSIONS.has(c)));
  if (!m.MANUFACTURING_INSTRUCTION_ROLES.includes(role) && has(m.MANUFACTURING_INSTRUCTION_PERMISSION)) out.push(m.MANUFACTURING_INSTRUCTION_PERMISSION);
  if (!m.MANUAL_CONTINUITY_ROLES.includes(role) && has(m.MANUAL_CONTINUITY_PERMISSION)) out.push(m.MANUAL_CONTINUITY_PERMISSION);
  if (role === m.SHOWCASE_ROLE) {
    out.push(...granted.filter((c) => !c.endsWith(':read') || c === 'masterdata:material:reveal'
      || c.startsWith('vault:') || c.startsWith('iam:') || c.startsWith('formula:')));
  }
  return out;
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function main(): Promise<void> {
  const since = arg('--since');
  if (!since) throw new Error('usage: tsx scripts/gen-permission-grants.ts --since <git-ref> [--out <file>]');
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const base = execFileSync('git', ['rev-parse', '--short', `${since}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim();

  const allNow = [...new Set([...RA_PERMISSIONS, ...current.CAPABILITY_PERMISSIONS])];
  const old = await loadAt(since);
  const oldCodes = new Set(old.codes);
  const oldRoles = new Map(old.roles.map((r) => [r.code, r]));

  const newCodes = allNow.filter((c) => !oldCodes.has(c));
  const newRoles = current.ROLES.filter((r) => !oldRoles.has(r.code));
  const grants: Array<[string, string]> = [];
  const removed: Array<[string, string]> = [];
  const refused: string[] = [];
  for (const role of current.ROLES) {
    const granted = allNow.filter((c) => role.select(c));
    const bad = violations(role.code, granted);
    if (bad.length) refused.push(`${role.code}: ${[...new Set(bad)].join(', ')}`);
    const before = oldRoles.get(role.code);
    for (const c of granted) if (!(before && oldCodes.has(c) && before.select(c))) grants.push([role.code, c]);
    if (before) for (const c of old.codes) if (before.select(c) && !(allNow.includes(c) && role.select(c))) removed.push([role.code, c]);
  }
  if (refused.length) throw new Error(`SECURITY: refusing to generate grants that break the seed's invariants:\n  ${refused.join('\n  ')}`);

  const L: string[] = [];
  L.push(`-- Additive IAM grants: ${base} -> ${head} (generated by scripts/gen-permission-grants.ts --since ${since}).`);
  L.push('-- Idempotent (every insert is NOT EXISTS-guarded); one transaction. Apply with psql -v ON_ERROR_STOP=1');
  L.push('-- against the RawProd MAIN database as the owner (DDL/DML) role. Never instead of this: pnpm db:seed.');
  L.push(`-- New permission codes (${newCodes.length}): ${newCodes.join(', ') || 'none'}`);
  L.push(`-- New roles (${newRoles.length}): ${newRoles.map((r) => r.code).join(', ') || 'none'}`);
  L.push(`-- New grants (${grants.length}):`);
  for (const [r, c] of grants) L.push(`--   ${r.padEnd(22)} ${c}`);
  if (removed.length) {
    L.push(`-- Grants REMOVED from the catalogue since ${base} (${removed.length}) -- NOT revoked here; revoke by hand if intended:`);
    for (const [r, c] of removed) L.push(`--   ${r.padEnd(22)} ${c}`);
  }
  L.push('', 'begin;', '');
  if (newCodes.length) {
    L.push('insert into iam.permission_master (permission_code, permission_name, module_name, status, created_by, updated_by)');
    L.push("select v.code, v.code, split_part(v.code, ':', 1), 'ACTIVE', 'release-grant', 'release-grant'");
    L.push(`  from (values ${newCodes.map((c) => `(${q(c)})`).join(', ')}) as v(code)`);
    L.push(' where not exists (select 1 from iam.permission_master p where p.permission_code = v.code);', '');
  }
  if (newRoles.length) {
    L.push('insert into iam.role_master (role_code, role_name, status, created_by, updated_by)');
    L.push("select v.code, v.name, 'ACTIVE', 'release-grant', 'release-grant'");
    L.push(`  from (values ${newRoles.map((r) => `(${q(r.code)}, ${q(r.name)})`).join(', ')}) as v(code, name)`);
    L.push(' where not exists (select 1 from iam.role_master r where r.role_code = v.code);', '');
  }
  if (grants.length) {
    L.push('insert into iam.role_permission_mapping (role_id, permission_id, status, created_by, updated_by)');
    L.push("select r.role_id, p.permission_id, 'ACTIVE', 'release-grant', 'release-grant'");
    L.push('  from (values');
    L.push(grants.map(([r, c]) => `    (${q(r)}, ${q(c)})`).join(',\n'));
    L.push('  ) as g(role_code, permission_code)');
    L.push('  join iam.role_master r on r.role_code = g.role_code');
    L.push('  join iam.permission_master p on p.permission_code = g.permission_code');
    L.push(' where not exists (select 1 from iam.role_permission_mapping m where m.role_id = r.role_id and m.permission_id = p.permission_id);', '');
  }
  L.push('commit;', '');
  const sql = L.join('\n');
  const out = arg('--out');
  if (out) writeFileSync(out, sql);
  else process.stdout.write(sql);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error((err as Error).message ?? err);
  process.exit(1);
});
