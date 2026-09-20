-- platform cluster — initial migration (forward-only). Hand-authored to match
-- ../src/schema (drizzle-kit generate was unavailable in the build sandbox; this
-- SQL is the exact translation and can be replaced by a regenerated set later).
--
-- Prerequisites (installed by src/migrate.ts before this runs): postgis, pg_trgm,
-- uuidv7().

CREATE SCHEMA IF NOT EXISTS "platform";

--> statement-breakpoint
-- geo_region_types (TEXT pk) --------------------------------------------------
CREATE TABLE "platform"."geo_region_types" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"typical_parent" text
);

--> statement-breakpoint
-- geo_regions (self-tree + PostGIS) -------------------------------------------
CREATE TABLE "platform"."geo_regions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type_key" text NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"code" text,
	"centroid" geometry(Point,4326),
	"boundary" geometry(MultiPolygon,4326),
	"metadata" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."geo_regions" ADD CONSTRAINT "geo_regions_type_key_geo_region_types_key_fk" FOREIGN KEY ("type_key") REFERENCES "platform"."geo_region_types"("key") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "geo_regions_type_idx" ON "platform"."geo_regions" ("type_key");
--> statement-breakpoint
CREATE INDEX "geo_regions_parent_idx" ON "platform"."geo_regions" ("parent_id");
--> statement-breakpoint
CREATE INDEX "geo_regions_code_idx" ON "platform"."geo_regions" ("code");
--> statement-breakpoint
CREATE INDEX "geo_regions_active_idx" ON "platform"."geo_regions" ("is_active");
--> statement-breakpoint
CREATE INDEX "geo_regions_name_trgm_idx" ON "platform"."geo_regions" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "geo_regions_centroid_gist" ON "platform"."geo_regions" USING gist ("centroid");
--> statement-breakpoint
CREATE INDEX "geo_regions_boundary_gist" ON "platform"."geo_regions" USING gist ("boundary");

--> statement-breakpoint
-- master_types (TEXT pk) ------------------------------------------------------
CREATE TABLE "platform"."master_types" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_hierarchical" boolean DEFAULT false NOT NULL
);

--> statement-breakpoint
-- master_items (self-tree) ----------------------------------------------------
CREATE TABLE "platform"."master_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type_key" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."master_items" ADD CONSTRAINT "master_items_type_key_master_types_key_fk" FOREIGN KEY ("type_key") REFERENCES "platform"."master_types"("key") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "master_items_type_key_uq" ON "platform"."master_items" ("type_key","key");
--> statement-breakpoint
CREATE INDEX "master_items_type_idx" ON "platform"."master_items" ("type_key");
--> statement-breakpoint
CREATE INDEX "master_items_parent_idx" ON "platform"."master_items" ("parent_id");
--> statement-breakpoint
CREATE INDEX "master_items_active_idx" ON "platform"."master_items" ("is_active");
--> statement-breakpoint
CREATE INDEX "master_items_label_trgm_idx" ON "platform"."master_items" USING gin ("label" gin_trgm_ops);

--> statement-breakpoint
-- checklist_templates ---------------------------------------------------------
CREATE TABLE "platform"."checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"applies_to" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_templates_key_uq" ON "platform"."checklist_templates" ("key");
--> statement-breakpoint
CREATE INDEX "checklist_templates_status_idx" ON "platform"."checklist_templates" ("status");

--> statement-breakpoint
-- checklist_template_versions -------------------------------------------------
CREATE TABLE "platform"."checklist_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamptz
);
--> statement-breakpoint
ALTER TABLE "platform"."checklist_template_versions" ADD CONSTRAINT "checklist_template_versions_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "platform"."checklist_templates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_template_versions_template_version_uq" ON "platform"."checklist_template_versions" ("template_id","version");
--> statement-breakpoint
CREATE INDEX "checklist_template_versions_template_idx" ON "platform"."checklist_template_versions" ("template_id");

--> statement-breakpoint
-- flags -----------------------------------------------------------------------
CREATE TABLE "platform"."flags" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"key" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'boolean' NOT NULL,
	"is_critical" boolean DEFAULT false NOT NULL,
	"default_state" text DEFAULT 'off' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flags_key_uq" ON "platform"."flags" ("key");

--> statement-breakpoint
-- flag_states -----------------------------------------------------------------
CREATE TABLE "platform"."flag_states" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"flag_id" uuid NOT NULL,
	"env" text NOT NULL,
	"state" text NOT NULL,
	"targeting" jsonb
);
--> statement-breakpoint
ALTER TABLE "platform"."flag_states" ADD CONSTRAINT "flag_states_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "platform"."flags"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "flag_states_flag_env_uq" ON "platform"."flag_states" ("flag_id","env");
--> statement-breakpoint
CREATE INDEX "flag_states_env_idx" ON "platform"."flag_states" ("env");

--> statement-breakpoint
-- flag_audit ------------------------------------------------------------------
CREATE TABLE "platform"."flag_audit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"flag_id" uuid NOT NULL,
	"env" text NOT NULL,
	"old_state" text,
	"new_state" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" uuid,
	"at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."flag_audit" ADD CONSTRAINT "flag_audit_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "platform"."flags"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "flag_audit_flag_idx" ON "platform"."flag_audit" ("flag_id");
--> statement-breakpoint
CREATE INDEX "flag_audit_env_idx" ON "platform"."flag_audit" ("env");
--> statement-breakpoint
CREATE INDEX "flag_audit_at_idx" ON "platform"."flag_audit" ("at");

--> statement-breakpoint
-- themes (TEXT pk) ------------------------------------------------------------
CREATE TABLE "platform"."themes" (
	"portal" text PRIMARY KEY NOT NULL,
	"tokens" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- content_blocks --------------------------------------------------------------
CREATE TABLE "platform"."content_blocks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slot" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"publish_at" timestamptz,
	"expire_at" timestamptz,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "content_blocks_slot_locale_idx" ON "platform"."content_blocks" ("slot","locale","sort_order");
--> statement-breakpoint
CREATE INDEX "content_blocks_status_idx" ON "platform"."content_blocks" ("status");

--> statement-breakpoint
-- config ----------------------------------------------------------------------
CREATE TABLE "platform"."config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "config_scope_key_uq" ON "platform"."config" ("scope","key");

--> statement-breakpoint
-- outbox (kernel factory) -----------------------------------------------------
CREATE TABLE "platform"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"aggregate_id" uuid,
	"occurred_at" timestamptz DEFAULT now() NOT NULL,
	"published_at" timestamptz,
	"attempts" integer DEFAULT 0 NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "platform"."outbox" ("occurred_at","seq") WHERE "platform"."outbox"."published_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "platform"."outbox" ("aggregate_id");

--> statement-breakpoint
-- audit_events (kernel factory) -----------------------------------------------
CREATE TABLE "platform"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"request_id" text,
	"ip" text,
	"occurred_at" timestamptz DEFAULT now() NOT NULL,
	"prev_hash" text,
	"row_hash" text
);
--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "platform"."audit_events" ("entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "platform"."audit_events" ("actor_id");
--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "platform"."audit_events" ("occurred_at");
--> statement-breakpoint
CREATE INDEX "audit_events_request_idx" ON "platform"."audit_events" ("request_id");
