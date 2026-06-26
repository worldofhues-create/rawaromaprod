/**
 * Response masking primitives for the formula-protection floor view. Pure + side-effect free
 * (so they are trivially testable and the interceptor stays thin).
 *
 * Rule: a caller WITHOUT the `masterdata:material:reveal` capability must never receive a real
 * material_id. We recursively strip every `materialId` from a response payload — setting it to
 * null (FAIL-CLOSED: the id is gone even if the alias couldn't be resolved) and attaching the
 * RM alias (`rmAliasId` + `aliasName`) so the floor still sees WHICH masked ingredient it is.
 */
import type { AliasRef } from '@ra/cluster-masterdata';

/** The capability that exempts a caller from masking (owner / qc / procurement hold it). */
export const MATERIAL_REVEAL_PERMISSION = 'masterdata:material:reveal';

/**
 * Only recurse into plain objects + arrays. Dates, Buffers, and other class instances are
 * returned untouched — walking them with Object.entries would silently destroy them.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Collect every `materialId` string value anywhere in the payload. */
export function collectMaterialIds(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectMaterialIds(v, acc);
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'materialId' && typeof v === 'string') acc.add(v);
      else collectMaterialIds(v, acc);
    }
  }
}

/**
 * Return a deep copy of `value` with every `materialId` masked: the real id replaced by null
 * and `rmAliasId` / `aliasName` set from `aliasMap` (null when the material has no alias).
 * Non-plain values (Date, etc.) and all other fields are preserved as-is.
 */
export function maskMaterialIds(value: unknown, aliasMap: Map<string, AliasRef>): unknown {
  if (Array.isArray(value)) return value.map((v) => maskMaterialIds(v, aliasMap));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'materialId' && typeof v === 'string') {
        const alias = aliasMap.get(v);
        out.materialId = null;
        out.rmAliasId = alias?.rmAliasId ?? null;
        out.aliasName = alias?.aliasName ?? null;
      } else {
        out[k] = maskMaterialIds(v, aliasMap);
      }
    }
    return out;
  }
  return value;
}
