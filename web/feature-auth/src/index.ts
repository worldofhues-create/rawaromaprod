// @core/feature-auth — reusable auth feature.
//   core/ = platform-agnostic logic (TanStack Query mutations, zustand session, client contract)
//   web/  = React screens (react-hook-form + zod from @core/contracts, composed from @core/ui)
// A future native target would add a sibling `native/` consuming the same `core/`.
export * from './core/index.js';
export * from './web/index.js';
