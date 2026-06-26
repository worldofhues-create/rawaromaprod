/**
 * Boundary lint — the mechanical guarantee that this stays a MODULAR MONOLITH.
 * Run: `pnpm boundaries`. CI fails on any violation.
 *
 * Three one-way tiers: @core/* (domain-free kernel) ← @mfg/* (manufacturing-generic)
 * ← @ra/* (perfume domain). A lower tier may NEVER import a higher one — that is what
 * keeps the reusable core pristine and every cluster independently extractable.
 * Clusters couple to each other ONLY through their `public-api.ts` (enforced here +
 * by each package's `exports` map). No cross-schema coupling, no cycles.
 *
 * Apps (backend/api, web/admin, mobile/consumer) are composition roots — they wire the
 * clusters together and are therefore allowed to import any tier.
 */
const CORE_SRC =
  '^(packages/(contracts|tokens|data-kernel|data-iam|data-platform)|' +
  'backend/(backend-kernel|cluster-identity|cluster-platform)|' +
  'web/(ui|feature-auth)|mobile/(ui-native|core))/src/';

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'No dependency cycles — they make modules un-extractable and un-reasonable.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-no-domain',
      comment:
        '@core/* (reusable kernel) must not import @mfg/* (manufacturing-generic) or ' +
        '@ra/* (perfume domain). Tiers flow one way: @ra → @mfg → @core, never the reverse.',
      severity: 'error',
      from: { path: CORE_SRC },
      to: { path: '@(mfg|ra)[/\\\\]' },
    },
    {
      name: 'mfg-no-ra',
      comment:
        '@mfg/* (manufacturing-generic, reusable across factories) must not import @ra/* ' +
        '(perfume domain). The generic core stays seedable by any manufacturing project.',
      severity: 'error',
      from: { path: '^(packages/mfg-|backend/mfg-)[^/]+/src/' },
      to: { path: '@ra[/\\\\]' },
    },
    {
      name: 'cluster-public-api-only',
      comment:
        'A backend cluster may import ANOTHER cluster ONLY through its public surface — its ' +
        'package barrel (index.ts, which exports the Module + public-api token, used to wire ' +
        'DI) or public-api.ts — never its internal services/schema. This is the modular- ' +
        'monolith boundary. ($1 backreference lets a cluster import its OWN internals freely.)',
      severity: 'error',
      from: { path: '^backend/(?:cluster|mfg)-([^/]+)/src/' },
      to: {
        // a different cluster's source...
        path: '^backend/(?:cluster|mfg)-([^/]+)/src/',
        // ...but allow its barrel (index.ts) + public-api.ts, and same-cluster ($1) internals.
        pathNot: ['(?:public-api|index)\\.ts$', '^backend/(?:cluster|mfg)-$1/src/'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|dist|drizzle|\\.run|\\.next|\\.turbo)' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      conditionNames: ['import', 'types', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
    },
  },
};
