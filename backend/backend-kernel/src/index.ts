/**
 * @core/backend-kernel — the reusable NestJS core (doc 01 §0, doc 02).
 *
 * Everything a deployable needs that is domain-free: config, per-schema Drizzle clients,
 * the edge layer (guards / interceptors / filter / middleware / zod pipe), the in-proc
 * event bus + transactional-outbox publisher, the in-memory flag snapshot, decorators,
 * and `/health`. Clusters depend on this; `api`/`worker` compose it via
 * `BackendKernelModule.forRoot()`.
 */

// Root module
export {
  BackendKernelModule,
  type BackendKernelOptions,
} from './backend-kernel.module.js';

// Config
export * from './config/index.js';

// Database (per-schema Drizzle clients + tokens)
export * from './db/index.js';

// Edge layer (guards, interceptors, filter, middleware, jwt, errors, pipe)
export * from './edge/index.js';

// Events (bus + outbox)
export * from './events/index.js';

// Flags (in-memory snapshot)
export * from './flags/index.js';

// Decorators
export * from './decorators/index.js';

// Health
export * from './health/index.js';
