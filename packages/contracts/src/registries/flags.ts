import { z } from 'zod';
import { portal } from './permissions.js';

/**
 * Flag (kill-switch) registry. Convention: `area.module.feature`.
 * `platform` cluster is the runtime source of truth; this declares the keys + metadata.
 *
 * FEATURE-SWITCHES (owner, 26 Nov 2026: "nothing should be a stub"): EVERY KEY HERE GUARDS REAL CODE,
 * and `guards` names where. The template this repository started from shipped keys for another
 * product (buyer offers, owner listings, builder projects, AI search, auto-assignment), none read by
 * anything; a switch that persists and changes nothing is a fake control on the Platform console, so
 * they are gone. A key is added here only together with the code that refuses when it is off, and a
 * test proving it (backend/api/src/__tests__/flags-wired.test.ts asserts every key is used).
 *
 *   description  what the switch stops, as the Platform console shows it
 *   whenOff      the sentence a refused request answers with, in words
 *   critical     turning it off stops production, sign-in, money or the switches themselves: a
 *                fresh sign-in is needed to change it
 */
export const FLAGS = [
  { key: 'all.auth', critical: true, guards: 'cluster-org AuthService: the ALEMBIC hand-off and refresh',
    description: 'Sign-in to the Factory and the Vault. The Platform console stays open, so it can be switched back on.',
    whenOff: 'Sign-in to the Factory and the Vault is switched off on the Platform console. Only the Platform console can be opened.' },
  { key: 'all.payments', critical: true, guards: 'prodfloor.controller.ts: supplier payment approve and release',
    description: 'Approving and releasing supplier payments.',
    whenOff: 'Supplier payment approvals and releases are switched off on the Platform console, so nothing was approved or released.' },
  { key: 'all.uploads', critical: false, guards: 'QC attachments, gate-entry documents, documents, the document registry',
    description: 'Document uploads: QC attachments, gate-entry documents, documents and the document registry.',
    whenOff: 'Document uploads are switched off on the Platform console, so nothing was saved.' },
  { key: 'all.search', critical: false, guards: 'search.controller.ts GET /v1/search',
    description: 'The factory search.',
    whenOff: 'Search is switched off on the Platform console.' },
  { key: 'admin.flags.write', critical: true, guards: 'flags.controller.ts PUT /v1/admin/flags/:key',
    description: 'Changing any switch. When off, the only change allowed is turning this one back on.',
    whenOff: 'Changing switches is itself switched off. The only change allowed is turning "admin.flags.write" back on.' },
  { key: 'production.batch.start', critical: true, guards: 'floor.controller.ts POST /v1/floor/jobs',
    description: 'Starting a new batch on the floor. Batches already started carry on.',
    whenOff: 'Starting new batches is switched off on the Platform console, so no batch was started. Batches already on the floor carry on.' },
  { key: 'floor.kiosk.writes', critical: true, guards: 'floor.controller.ts: pick, verify, mix, leftover, over-pick and resume steps',
    description: 'Floor kiosk steps: pick, verify, mix, leftovers. When off the kiosks are read-only.',
    whenOff: 'The floor kiosks are read-only: recording steps is switched off on the Platform console, so nothing was recorded.' },
  { key: 'qc.release', critical: true, guards: 'GRN QC disposition, batch QC decision, CoA release, raw-material lot release, finished-goods QC (packaging-qc)',
    description: 'QC releases and decisions: receiving dispositions, batch QC decisions, finished-goods QC, CoA and raw-material lot releases.',
    whenOff: 'QC releases are switched off on the Platform console, so nothing was released or decided.' },
  { key: 'procurement.po.approve', critical: false, guards: 'po.controller.ts POST /v1/purchase-orders/:id/approve',
    description: 'Approving purchase orders.',
    whenOff: 'Approving purchase orders is switched off on the Platform console, so the order was not approved.' },
] as const;

/** The sentence a request refused by `key` answers with; a key not in the registry gets a plain one. */
export function flagOffSentence(key: string): string {
  const f = (FLAGS as readonly { key: string; whenOff: string }[]).find((x) => x.key === key);
  return f ? f.whenOff : `"${key}" is switched off on the Platform console.`;
}

export type FlagKey = (typeof FLAGS)[number]['key'];

export const flagState = z.enum(['on', 'off', 'degraded']);
export type FlagState = z.infer<typeof flagState>;

/** Targeting rules for a flag state — any matching dimension narrows the rollout. */
export const flagTargeting = z
  .object({
    portals: z.array(portal).optional(),
    roles: z.array(z.string()).optional(),
    cityIds: z.array(z.string().uuid()).optional(),
    percent: z.number().int().min(0).max(100).optional(),
  })
  .partial();
export type FlagTargeting = z.infer<typeof flagTargeting>;

/** The snapshot shape the edge layer + clients evaluate in-memory (sub-ms). */
export const flagSnapshot = z.object({
  key: z.string(),
  state: flagState,
  targeting: flagTargeting.nullable(),
});
export type FlagSnapshot = z.infer<typeof flagSnapshot>;
