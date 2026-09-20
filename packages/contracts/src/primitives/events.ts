import { z } from 'zod';
import { uuid } from './ids.js';

/**
 * The domain-event envelope. Identical shape in-process (today) and over a broker
 * (extraction stage) — this is what makes a cluster extractable without changing semantics.
 * Type convention: `cluster.entity.verb` (past tense), e.g. `property.listing.submitted`.
 */
export const eventEnvelope = <T extends z.ZodTypeAny>(type: string, payload: T) =>
  z.object({
    id: uuid.describe('event id (uuidv7)'),
    type: z.literal(type),
    occurredAt: z.string().datetime(),
    actor: uuid.nullable().describe('user/system id that caused the event'),
    requestId: z.string(),
    version: z.number().int().min(1).default(1),
    payload,
  });

/** Helper to declare an event contract once and reuse its name + schema. */
export const defineEvent = <T extends z.ZodTypeAny>(type: string, payload: T) => ({
  type,
  schema: eventEnvelope(type, payload),
});
