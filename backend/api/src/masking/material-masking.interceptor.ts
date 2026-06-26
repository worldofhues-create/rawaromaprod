/**
 * MaterialMaskingInterceptor — the BFF response-projection layer for formula protection.
 *
 * Runs on EVERY HTTP response. If the caller holds `masterdata:material:reveal` (owner / qc /
 * procurement), the payload passes through untouched. Otherwise (the production floor, any
 * future role, or — fail-safe — an unrecognised caller) every `materialId` in the response is
 * stripped to null and replaced with its RM alias, so the floor sees ING-aliases, never the real
 * material identity. This complements the vault: the FORMULA recipe is sealed at rest + owner-only,
 * and here the per-order operational material ids are masked in transit for the floor.
 *
 * Registered AFTER ResponseEnvelopeInterceptor so, on the response path, masking runs FIRST on the
 * raw handler output (incl. an unhoisted `{ items, nextCursor }` page) and the envelope then wraps
 * the already-masked data.
 */
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, from, mergeMap } from 'rxjs';
import { type RequestWithUser } from '@core/backend-kernel';
import { MASTERDATA_LOOKUP, type AliasRef, type MasterdataLookup } from '@ra/cluster-masterdata';
import { MATERIAL_REVEAL_PERMISSION, collectMaterialIds, maskMaterialIds } from './mask.js';

@Injectable()
export class MaterialMaskingInterceptor implements NestInterceptor {
  constructor(@Inject(MASTERDATA_LOOKUP) private readonly masterdata: MasterdataLookup) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const principal = context.switchToHttp().getRequest<RequestWithUser>().user;
    // Reveal-capable callers (and only them) bypass masking. No principal / malformed perms →
    // still mask (fail-safe); the optional chain on `permissions` avoids a 500 on a bad principal.
    if (principal?.permissions?.includes(MATERIAL_REVEAL_PERMISSION)) {
      return next.handle();
    }

    return next.handle().pipe(
      mergeMap((payload: unknown) => from(this.mask(payload))),
    );
  }

  private async mask(payload: unknown): Promise<unknown> {
    const ids = new Set<string>();
    collectMaterialIds(payload, ids);
    if (ids.size === 0) return payload;

    let aliasMap = new Map<string, AliasRef>();
    try {
      aliasMap = await this.masterdata.findAliasesForMaterials([...ids]);
    } catch {
      // Fail closed: even if alias resolution fails, maskMaterialIds still strips the real id.
      aliasMap = new Map<string, AliasRef>();
    }
    return maskMaterialIds(payload, aliasMap);
  }
}
