/**
 * The canonical schema-group map for programmatic push/generate (bypasses the drizzle-kit CLI
 * loader, which can't resolve the NodeNext `.js` import specifiers). Two pg schemas are
 * co-located across packages and MUST be pushed as a single merged import set, or the second
 * push would diff-drop the first's tables:
 *   - iam      = @core/data-iam (kernel users/outbox/audit) + @ra/data-org (dict iam masters)
 *   - platform = @core/data-platform + @ra/data-reference (dict platform masters)
 * The formula schema lives on its OWN connection (ra_vault role / FORMULA_DATABASE_URL).
 */
export interface SchemaGroup {
  schema: string;
  packages: string[];
  /** true → push to FORMULA_DATABASE_URL (vault's own role), not the app DATABASE_URL. */
  vault?: boolean;
}

export const SCHEMA_GROUPS: SchemaGroup[] = [
  { schema: 'iam', packages: ['@core/data-iam', '@ra/data-org'] },
  { schema: 'platform', packages: ['@core/data-platform', '@ra/data-reference'] },
  { schema: 'location', packages: ['@ra/data-location'] },
  { schema: 'masterdata', packages: ['@ra/data-masterdata'] },
  { schema: 'procurement', packages: ['@ra/data-procurement'] },
  { schema: 'inventory', packages: ['@ra/data-inventory'] },
  { schema: 'quality', packages: ['@ra/data-quality'] },
  { schema: 'production', packages: ['@ra/data-production'] },
  { schema: 'packaging', packages: ['@ra/data-packaging'] },
  { schema: 'sales', packages: ['@ra/data-sales'] },
  { schema: 'workflow', packages: ['@ra/data-workflow-state'] },
  { schema: 'formula', packages: ['@ra/data-formula'], vault: true },
];

/** Merge the table exports of every package in a group into one imports object (keys prefixed). */
export async function loadGroup(packages: string[]): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {};
  for (const pkg of packages) {
    const mod: Record<string, unknown> = await import(pkg);
    for (const [k, v] of Object.entries(mod)) merged[`${pkg.replace(/[^a-z]/gi, '_')}__${k}`] = v;
  }
  return merged;
}
