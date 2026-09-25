/**
 * The MAIN app box's side of the Formula Vault trust boundary. Everything the main box needs from
 * the Vault goes over the signed internal channel (INTERNAL_BRIDGE_KEY HMAC + nonce,
 * VAULT_API_INTERNAL_URL) and nothing else: `AppModule`/`WorkerModule` do not import
 * `FormulaModule`, so no `FORMULA_PG_CLIENT` pool is ever created on that box and
 * `FORMULA_DATABASE_URL` is unused there (the Vault isolation lets the app box reach only the
 * Vault API port, never vault-pg:5432).
 *
 *   - `VaultApiClient` — the signed HTTP calls, in their WIRE shapes (`CodedPickLine`,
 *     `CodedMaterialLine`: keyed material references, material-ref.ts), answered by
 *     `vault-port-internal.controller.ts` on the Vault box (`VaultAppModule` only).
 *   - `VaultPort` (`VAULT_PORT`) — what production code reads: the order's pick list with THIS
 *     box's material ids, and the §109.7 coded instruction with floor codes. Implemented on the main
 *     box by `@ra/cluster-production`'s `ProductionVaultPort`, which calls `VaultApiClient` and
 *     resolves each keyed reference against this box's own masterdata. The Vault never has to
 *     call back into the main box to answer.
 *   - `VaultSecurityAuditClient` (`SECURITY_AUDIT_SINK`) — the edge guards' and SecurityService's
 *     sensitive refusals land on the Vault's hash-chained `formula.audit_events`.
 *
 * The caller's own permission is checked on the main box (the route's `@Permissions`); the Vault
 * checks the signed channel (`InternalBridgeGuard`).
 */
import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  Global,
  HttpException,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ConfigModule,
  ConfigService,
  SECURITY_AUDIT_SINK,
  computeInternalBridgeSignature,
  type SecurityAuditEntry,
  type SecurityAuditSink,
} from '@core/backend-kernel';
import type { CodedInstruction, CodedMaterialLine, CodedPickLine, ReadContext } from './public-api.js';

/** DI token for `VaultPort`. Inject with `@Inject(VAULT_PORT)`. */
export const VAULT_PORT = Symbol('VAULT_PORT');

/** One line of a production order's bill of materials, resolved to THIS box's material row. */
export interface PickLine {
  materialId: string;
  /** Decimal string at production_order_ingredients.required_qty's scale (pick-quantity.ts). */
  requiredQty: string;
  sequenceNo: number | null;
}

/** The formula reads the main box's production flow makes — see this file's header. */
export interface VaultPort {
  /**
   * §109.7 coded manufacturing instruction for `permittedBatchQuantity` (floor code + quantity).
   * null if the version doesn't exist; 403 if it isn't approved/locked. A line whose material has
   * no floor code on this box comes back with `code: null` (callers refuse it).
   */
  resolveManufacturingInstruction(
    formulaVersionId: string,
    permittedBatchQuantity: number,
    ctx: ReadContext,
  ): Promise<CodedInstruction[] | null>;
  /**
   * The bill of materials for a production order of `orderQty`, one line per ingredient in
   * sequence order. null if the version doesn't exist; 403 if it isn't approved/locked.
   */
  resolvePickList(formulaVersionId: string, orderQty: number, ctx: ReadContext): Promise<PickLine[] | null>;
}

/** The internal paths the Vault box serves (vault-port-internal.controller.ts). */
export const VAULT_INTERNAL_PATHS = {
  /** Legacy alias-resolving instruction; needs the Vault -> main facts bridge. Not called by this box. */
  manufacturingInstruction: '/internal/vault/resolve-manufacturing-instruction',
  manufacturingLines: '/internal/vault/resolve-manufacturing-lines',
  pickList: '/internal/vault/resolve-pick-list',
  securityAudit: '/internal/vault/security-audit',
} as const;

/** Upper bound on one Vault round trip (it may include a KMS unwrap). */
export const VAULT_CALL_TIMEOUT_MS = 15_000;

interface InternalErrorBody {
  error?: { message?: string; code?: string };
}

/** Re-throw the Vault's own HTTP status as the equivalent Nest exception, so `AllExceptionsFilter`
 *  on the MAIN box maps it to the SAME status/code a local call would have produced (e.g. 403 when
 *  the version isn't approved/locked yet — see `VaultService.decryptVersion`). */
function throwForStatus(status: number, message: string): never {
  if (status === 403) throw new ForbiddenException(message);
  if (status === 404) throw new NotFoundException(message);
  throw new HttpException(message, status || 500);
}

/** The signed HTTP calls to the Vault's internal API, in wire shapes. */
@Injectable()
export class VaultApiClient {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async pickList(formulaVersionId: string, orderQty: number, ctx: ReadContext): Promise<CodedPickLine[] | null> {
    const data = await this.post<{ result: CodedPickLine[] | null }>(VAULT_INTERNAL_PATHS.pickList, {
      formulaVersionId,
      orderQty,
      ctx,
    });
    return data?.result ?? null;
  }

  async manufacturingLines(
    formulaVersionId: string,
    permittedBatchQuantity: number,
    ctx: ReadContext,
  ): Promise<CodedMaterialLine[] | null> {
    const data = await this.post<{ result: CodedMaterialLine[] | null }>(VAULT_INTERNAL_PATHS.manufacturingLines, {
      formulaVersionId,
      permittedBatchQuantity,
      ctx,
    });
    return data?.result ?? null;
  }

  async recordSecurityAudit(entry: SecurityAuditEntry): Promise<void> {
    await this.post<unknown>(VAULT_INTERNAL_PATHS.securityAudit, entry);
  }

  /** One signed POST; returns the response envelope's `data`. */
  private async post<T>(path: string, payload: unknown): Promise<T> {
    const baseUrl = this.config.get('VAULT_API_INTERNAL_URL');
    const key = this.config.get('INTERNAL_BRIDGE_KEY');
    if (!baseUrl || !key) {
      // 503 with the reason, not an anonymous 500: this is a deployment gap an operator must see.
      throw new ServiceUnavailableException(
        'VAULT_API_INTERNAL_URL and INTERNAL_BRIDGE_KEY must both be configured to reach the ' +
          'Vault (VaultApiClient) — formula reads are unavailable on this box without them.',
      );
    }
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const signature = computeInternalBridgeSignature(key, { method: 'POST', path, body, timestamp, nonce });

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-signature': signature,
          'x-internal-timestamp': timestamp,
          'x-internal-nonce': nonce,
        },
        body,
        signal: AbortSignal.timeout(VAULT_CALL_TIMEOUT_MS),
      });
    } catch (err) {
      // Unreachable or too slow: say so (503) instead of surfacing a raw socket error as a 500.
      throw new ServiceUnavailableException(`The Formula Vault is unreachable (${path}): ${(err as Error).message}`);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as InternalErrorBody & { data?: T }) : {};
    if (!res.ok) {
      throwForStatus(res.status, json.error?.message ?? `Vault call ${path} failed with status ${res.status}`);
    }
    return json.data as T;
  }
}

/**
 * `SECURITY_AUDIT_SINK` for the main app box: forwards each sensitive refusal/grant record to the
 * Vault, which appends it to `formula.audit_events` (`VaultSecurityAuditSink` there). Callers
 * already treat a failed write as non-fatal (they `.catch()` it), so an unreachable Vault never
 * turns a refusal into a pass or delays one by more than `VAULT_CALL_TIMEOUT_MS`.
 */
@Injectable()
export class VaultSecurityAuditClient implements SecurityAuditSink {
  constructor(@Inject(VaultApiClient) private readonly client: VaultApiClient) {}

  record(entry: SecurityAuditEntry): Promise<void> {
    return this.client.recordSecurityAudit(entry);
  }
}

/**
 * VaultPortModule — the main app box's transport to the Vault: `VaultApiClient` and
 * `SECURITY_AUDIT_SINK`. Global, because the sink is injected by the edge guards (`APP_GUARD`) and
 * cluster-org's SecurityService. `VAULT_PORT` itself is provided by `ProductionModule` (it resolves
 * keyed references against the main database). NOT imported by `VaultAppModule` — the Vault box
 * never calls itself (its `FormulaModule` binds `FORMULA_LOOKUP` and the local audit sink).
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    VaultApiClient,
    VaultSecurityAuditClient,
    { provide: SECURITY_AUDIT_SINK, useExisting: VaultSecurityAuditClient },
  ],
  exports: [VaultApiClient, SECURITY_AUDIT_SINK],
})
export class VaultPortModule {}
