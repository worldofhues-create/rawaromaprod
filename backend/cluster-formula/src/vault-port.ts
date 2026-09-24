/**
 * VaultPort — §109.7's `VaultPort.resolveManufacturingInstruction`, as reached from the MAIN
 * app box (PB-03 remainder). A narrow subset of `FormulaLookup` (public-api.ts) — ONLY the
 * coded-instruction read, never `getFloorView`/`getPickList` (those still resolve locally, off
 * this box's OWN `FormulaModule`/`FORMULA_LOOKUP` — see `production.module.ts`'s doc comment for
 * exactly which reads travel this port today and which don't, and why).
 *
 * Two bindings exist:
 *   - `VaultPortHttpClient` (this file) — a signed HTTP call to the standalone Vault EC2's
 *     internal endpoint (`vault-port-internal.controller.ts`, mounted only by `VaultAppModule`).
 *     This is what `VaultPortModule` below provides, and what `ProductionModule` imports —
 *     the main app box's `PickingService` reaches the Vault over the network, not in-process.
 *   - the Vault box's OWN `FormulaLookupService` structurally satisfies this same interface
 *     (it has a superset of these methods) — the internal controller on the Vault side injects
 *     `FORMULA_LOOKUP` directly rather than going through this token, since it already IS the
 *     vault, in-process.
 */
import { Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService, ConfigModule, computeInternalBridgeSignature } from '@core/backend-kernel';
import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import type { CodedInstruction, ReadContext } from './public-api.js';

/** DI token for `VaultPort`. Inject with `@Inject(VAULT_PORT)`. */
export const VAULT_PORT = Symbol('VAULT_PORT');

export interface VaultPort {
  /** See `FormulaLookup.resolveManufacturingInstruction` (public-api.ts) — identical contract,
   *  reached over the signed internal channel instead of in-process. */
  resolveManufacturingInstruction(
    formulaVersionId: string,
    permittedBatchQuantity: number,
    ctx: ReadContext,
  ): Promise<CodedInstruction[] | null>;
}

interface InternalErrorBody {
  error?: { message?: string; code?: string };
}

/** Re-throw the Vault's own HTTP status as the equivalent Nest exception, so `AllExceptionsFilter`
 *  on the MAIN box maps it to the SAME status/code a local `FormulaLookup` call would have
 *  produced (e.g. 403 when the version isn't approved/locked yet — see `VaultService.decryptVersion`). */
function throwForStatus(status: number, message: string): never {
  if (status === 403) throw new ForbiddenException(message);
  if (status === 404) throw new NotFoundException(message);
  throw new HttpException(message, status || 500);
}

@Injectable()
export class VaultPortHttpClient implements VaultPort {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async resolveManufacturingInstruction(
    formulaVersionId: string,
    permittedBatchQuantity: number,
    ctx: ReadContext,
  ): Promise<CodedInstruction[] | null> {
    const baseUrl = this.config.get('VAULT_API_INTERNAL_URL');
    const key = this.config.get('INTERNAL_BRIDGE_KEY');
    if (!baseUrl || !key) {
      throw new Error(
        'VAULT_API_INTERNAL_URL and INTERNAL_BRIDGE_KEY must both be configured to reach the ' +
          'Vault (VaultPortHttpClient) — production coded-instruction resolution is unavailable.',
      );
    }

    const path = '/internal/vault/resolve-manufacturing-instruction';
    const body = JSON.stringify({ formulaVersionId, permittedBatchQuantity, ctx });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeInternalBridgeSignature(key, { method: 'POST', path, body, timestamp });

    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': signature,
        'x-internal-timestamp': timestamp,
      },
      body,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as InternalErrorBody & { data?: { result: CodedInstruction[] | null } }) : {};
    if (!res.ok) {
      throwForStatus(res.status, json.error?.message ?? `VaultPort call failed with status ${res.status}`);
    }
    return json.data?.result ?? null;
  }
}

/**
 * VaultPortModule — provides `VAULT_PORT` bound to the remote HTTP client. Imported by
 * `ProductionModule` alongside `FormulaModule` (the latter still supplies `FORMULA_LOOKUP`
 * locally for `getPickList`, out of this port's scope — see this file's header). NOT imported
 * by `VaultAppModule`; the vault box never needs to call itself.
 */
@Module({
  imports: [ConfigModule],
  providers: [{ provide: VAULT_PORT, useClass: VaultPortHttpClient }],
  exports: [VAULT_PORT],
})
export class VaultPortModule {}
