/**
 * The boundary event contract — WHAT is allowed to cross the air gap, in WHICH direction.
 *
 * The two consoles never sync; only these event types travel, as signed packages:
 *   online-to-offline : orders + master data the factory needs to produce (NO money/customer PII
 *                       beyond the order ref).
 *   offline-to-online : production / QC / dispatch RESULTS — never the recipe, never the KEK.
 *
 * Hard rule enforced independently of the lists: anything under `formula.*` (vault / recipe) NEVER
 * crosses in any direction. This is defense-in-depth — even if a formula event were mistakenly
 * listed, `isForbiddenAcrossGap` strips it, and the exporter never scans the formula schema.
 */
export const RELAY_DIRECTIONS = ['online-to-offline', 'offline-to-online'] as const;
export type RelayDirection = (typeof RELAY_DIRECTIONS)[number];

export function isRelayDirection(v: unknown): v is RelayDirection {
  return typeof v === 'string' && (RELAY_DIRECTIONS as readonly string[]).includes(v);
}

/** Schemas the exporter scans. `formula` is deliberately absent — vault events never leave. */
export const RELAY_SOURCE_SCHEMAS = [
  'masterdata',
  'procurement',
  'inventory',
  'quality',
  'production',
  'packaging',
  'sales',
] as const;

export const RELAY_CONTRACT: Record<RelayDirection, string[]> = {
  // Store → factory: what to make, and the master data to make it against.
  'online-to-offline': [
    'sales.order.created',
    'sales.order.confirmed',
    'masterdata.material.created',
    'masterdata.alias.created',
    'procurement.po.issued',
  ],
  // Factory → store: results only. NEVER a recipe, a formula version, or a key.
  'offline-to-online': [
    'packaging.fg_batch.created',
    'packaging.order.created',
    'packaging.filling.done',
    'quality.qc.passed',
    'quality.qc.failed',
    'quality.qc.hold',
    'production.order.created',
    'production.materials.issued',
    'production.oil_batch.created',
    'production.qc.recorded',
    'inventory.grn.created',
    'inventory.batch.created',
    'sales.dispatch.created',
  ],
};

/** A type that must NEVER cross the gap regardless of the direction lists. */
export function isForbiddenAcrossGap(type: string): boolean {
  return type.startsWith('formula.');
}

/** The effective allow-list for a direction (contract minus anything forbidden). */
export function allowedTypes(direction: RelayDirection): string[] {
  return RELAY_CONTRACT[direction].filter((t) => !isForbiddenAcrossGap(t));
}
