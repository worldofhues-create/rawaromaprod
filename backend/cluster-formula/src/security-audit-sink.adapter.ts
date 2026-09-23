/**
 * VaultSecurityAuditSink — the formula cluster's implementation of `@core/backend-kernel`'s
 * domain-free `SECURITY_AUDIT_SINK` port (security review item 5). Forwards every denial into
 * the SAME tamper-evident hash chain `VaultService` already writes plaintext-read audit rows
 * into (`formula.audit_events`), via the existing standalone-transaction path
 * (`writeStandaloneAudit`) — no new table, no change to the chain's hashing. Bound in
 * `FormulaModule` (a `@Global()` module), so it is available for optional injection anywhere
 * in the app (the edge guards, `cluster-org`'s SecurityService) without those packages
 * depending on `@ra/cluster-formula` directly.
 */
import { Injectable } from '@nestjs/common';
import type { SecurityAuditEntry, SecurityAuditSink } from '@core/backend-kernel';
import { VaultService } from './vault.service.js';

@Injectable()
export class VaultSecurityAuditSink implements SecurityAuditSink {
  constructor(private readonly vault: VaultService) {}

  async record(entry: SecurityAuditEntry): Promise<void> {
    await this.vault.writeStandaloneAudit({
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      requestId: entry.requestId ?? null,
      ip: entry.ip ?? null,
      reason: entry.reason ?? null,
      result: entry.result ?? 'refuse',
    });
  }
}
