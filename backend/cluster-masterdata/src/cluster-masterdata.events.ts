/**
 * masterdata cluster events — inline `defineEvent` descriptors for the cross-cluster
 * signals this cluster emits. Payloads carry ids / soft-refs ONLY (no business columns):
 * downstream consumers cold-read via the lookup ports. Recorded into `masterdata.outbox`
 * inside the same transaction as the write (see cluster-masterdata.service.ts).
 */
import { z } from 'zod';
import { defineEvent } from '@core/contracts';

export const masterdataEvents = {
  /** A new material master was created. */
  materialCreated: defineEvent(
    'masterdata.material.created',
    z.object({ materialId: z.string().uuid() }),
  ),
  /** A new rm_alias (masking alias) was created for a material. */
  aliasCreated: defineEvent(
    'masterdata.alias.created',
    z.object({ rmAliasId: z.string().uuid(), materialId: z.string().uuid() }),
  ),
} as const;
