/**
 * platform schema barrel — every table in the platform cluster (doc 10 §4).
 * drizzle.config.ts points `schema` here.
 *
 * Tables: geo_region_types, geo_regions, master_types, master_items,
 *   checklist_templates, checklist_template_versions, flags, flag_states,
 *   flag_audit, themes, content_blocks, config, + outbox, audit_events.
 */
export { platform } from "./_schema.js";

export { geoRegionTypes, geoRegions } from "./geo.js";
export { masterTypes, masterItems } from "./masters.js";
export {
  checklistTemplates,
  checklistTemplateVersions,
} from "./checklists.js";
export { flags, flagStates, flagAudit } from "./flags.js";
export { themes, contentBlocks, config } from "./content.js";
export { outbox, auditEvents } from "./crosscutting.js";
