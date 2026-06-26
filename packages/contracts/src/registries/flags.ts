import { z } from 'zod';
import { portal } from './permissions.js';

/**
 * Flag (kill-switch) registry. Convention: `portal.module.feature[.route]`.
 * A feature CANNOT ship without a registered flag key (lint rule downstream).
 * `platform` cluster is the runtime source of truth; this declares the keys + metadata.
 */
export const FLAGS = [
  // platform-wide panic switches
  { key: 'all.auth', critical: true, description: 'Master auth kill-switch' },
  { key: 'all.payments', critical: true, description: 'Master payments kill-switch' },
  { key: 'all.uploads', critical: false, description: 'Master media/document upload switch' },
  { key: 'all.search', critical: false, description: 'Master search switch' },
  // buyer
  { key: 'buyer.search.ai', critical: false, description: 'AI search (phase 2 stub)' },
  { key: 'buyer.offers.counter', critical: false, description: 'Offer counter action' },
  // seller / owner
  { key: 'owner.listings.submit', critical: false, description: 'Listing submission' },
  { key: 'builder.projects.import', critical: false, description: 'Bulk unit CSV import' },
  // ops / trust
  { key: 'ops.assignment.auto', critical: false, description: 'Auto-assignment engine (P1.5)' },
  // admin
  { key: 'admin.flags.write', critical: true, description: 'Flag mutation (guard the guard)' },
] as const;

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
