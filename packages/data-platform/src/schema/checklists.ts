/**
 * platform checklist templates (doc 10 §4). Admin builds them here; trust consumes
 * them by id+version. Versions are IMMUTABLE once published → an inspection pins the
 * exact version it ran (evidence integrity, doc 05).
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns } from "@core/data-kernel";
import { platform } from "./_schema.js";

/**
 * checklist_templates — `key` UK; `applies_to` jsonb (property types etc.);
 * `current_version` points at the live version number.
 */
export const checklistTemplates = platform.table(
  "checklist_templates",
  {
    ...baseColumns(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    appliesTo: jsonb("applies_to"),
    status: text("status").notNull().default("draft"),
    currentVersion: integer("current_version").notNull().default(0),
  },
  (t) => [
    uniqueIndex("checklist_templates_key_uq").on(t.key),
    index("checklist_templates_status_idx").on(t.status),
  ],
);

/**
 * checklist_template_versions — immutable once `published_at` is set. `sections`
 * jsonb encodes sections→items (boolean|rating|text|measurement). FK template_id
 * (in-schema). (template_id, version) unique.
 */
export const checklistTemplateVersions = platform.table(
  "checklist_template_versions",
  {
    ...baseColumns(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => checklistTemplates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    sections: jsonb("sections").notNull().default(sql`'[]'::jsonb`),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("checklist_template_versions_template_version_uq").on(
      t.templateId,
      t.version,
    ),
    index("checklist_template_versions_template_idx").on(t.templateId),
  ],
);
