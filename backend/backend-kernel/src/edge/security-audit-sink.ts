/**
 * SecurityAuditSink — a domain-free port for recording SENSITIVE authorization refusals at the
 * edge layer (PermissionsGuard/FreshAuthGuard 403s on vault/formula-approval-gated routes)
 * into the tamper-evident audit chain the formula cluster owns (`formula.audit_events` — see
 * `VaultService.writeStandaloneAudit`). backend-kernel must stay domain-free (it is the base
 * every cluster depends ON, so it can never import a cluster back), so this file defines ONLY
 * the interface + DI token. `@ra/cluster-formula`'s FormulaModule (a `@Global()` module)
 * provides + exports the real implementation; every caller here injects it OPTIONALLY (guards
 * run for every request app-wide, including in any future deployable that doesn't compose
 * FormulaModule) — a denied request must still 403 even if no sink is wired, and a sink write
 * failure must never turn a refusal into a silent pass.
 */
export const SECURITY_AUDIT_SINK = Symbol('SECURITY_AUDIT_SINK');

export interface SecurityAuditEntry {
  actorId: string | null;
  /** e.g. 'security.permission.denied', 'security.freshauth.denied'. */
  action: string;
  entityType: string;
  entityId: string | null;
  requestId?: string | null;
  ip?: string | null;
  reason?: string | null;
  result?: 'allow' | 'refuse';
}

export interface SecurityAuditSink {
  record(entry: SecurityAuditEntry): Promise<void>;
}
