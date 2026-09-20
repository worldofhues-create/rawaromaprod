import { z } from 'zod';
import { uuid } from '../../primitives/ids.js';
import { flagSnapshot, flagState, flagTargeting } from '../../registries/flags.js';

/** `GET /flags/snapshot?portal=` → the in-memory snapshot clients evaluate. */
export const flagSnapshotResponse = z.object({
  portal: z.string(),
  flags: z.array(flagSnapshot),
  /** opaque version so clients can detect staleness on the SSE stream. */
  version: z.string(),
});

/** Admin: `PUT /admin/flags/:key` — mutate a flag state (audited, reason mandatory). */
export const setFlagRequest = z.object({
  env: z.enum(['staging', 'prod']),
  state: flagState,
  targeting: flagTargeting.nullable().optional(),
  reason: z.string().min(3).describe('mandatory — written to flag_audit'),
});

export const flagAuditEntry = z.object({
  id: uuid,
  flagKey: z.string(),
  env: z.string(),
  oldState: flagState.nullable(),
  newState: flagState,
  reason: z.string(),
  actorId: uuid,
  at: z.string().datetime(),
});
