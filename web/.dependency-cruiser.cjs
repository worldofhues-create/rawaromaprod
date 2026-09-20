/**
 * dependency-cruiser — mechanical TIER DISCIPLINE for the web layer (docs/01 §8).
 *
 * Reuse tiers (matching the backend cluster boundaries):
 *   Tier 1 — generic packages : web/ui            (@core/ui)            — DOMAIN-FREE
 *   Tier 2 — domain features   : web/feature-*     (@core/feature-*)
 *   Tier 3 — apps              : web/admin, …      (thin shells)
 *
 * Rule of thumb enforced here (violations FAIL CI):
 *   - Tier 1 may NEVER import a Tier 2 feature or a Tier 3 app.
 *   - Tier 2 may NEVER import a Tier 3 app.
 *   - Nothing imports an app.
 *
 * Pair this with a domain-vocabulary lint over web/ui/src (a banned-word list —
 * property / listing / inspection / trust-as-domain / offer …) so a `PropertyCard`
 * physically cannot land in @core/ui. (`--color-trust` the TOKEN is allowed; a domain
 * *type* named trust is not.) Run: `depcruise --config web/.dependency-cruiser.cjs web`.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'ui-no-feature-imports',
      comment: 'Tier 1 (@core/ui) must stay domain-free — it may not import any feature.',
      severity: 'error',
      from: { path: '^web/ui/' },
      to: { path: '^web/feature-' },
    },
    {
      name: 'ui-no-app-imports',
      comment: 'Tier 1 (@core/ui) may not import an app.',
      severity: 'error',
      from: { path: '^web/ui/' },
      to: { path: '^web/(admin|seller|marketplace|ops)/' },
    },
    {
      name: 'feature-no-app-imports',
      comment: 'Tier 2 features may not import a Tier 3 app.',
      severity: 'error',
      from: { path: '^web/feature-' },
      to: { path: '^web/(admin|seller|marketplace|ops)/' },
    },
    {
      name: 'no-circular',
      comment: 'No circular dependencies.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    exclude: { path: 'node_modules' },
  },
};
