// Primitives — shared API shapes
export * from './primitives/index.js';

// Registries — error codes, permissions, flags (the typed source of truth)
export * from './registries/index.js';

// Clusters — namespaced contracts
export * as identity from './clusters/identity/index.js';
export * as platform from './clusters/platform/index.js';

/** All domain events in one place (for the worker's typed subscriber map). */
export { identityEvents } from './clusters/identity/events.js';
export { platformEvents } from './clusters/platform/events.js';
