/**
 * SWEEP2-R1 (Vault): the same interceptor on the Vault API, on its own connection. Kept out of
 * idempotency.interceptor.ts so the main box's module graph never names the formula database.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { FORMULA_PG_CLIENT } from '@ra/cluster-formula';
import { IdempotencyInterceptorBase, IdempotencyStore } from './idempotency.interceptor.js';

/** The Vault API: formula.idempotency_key on the Vault's own FORMULA_DATABASE_URL (the Vault box
 *  has no path to the main database). Same rules, so a formula write re-sent by the channel lands once. */
@Injectable()
export class VaultIdempotencyInterceptor extends IdempotencyInterceptorBase {
  constructor(@Inject(FORMULA_PG_CLIENT) sql: Sql) { super(new IdempotencyStore(sql, 'formula.idempotency_key')); }
}
