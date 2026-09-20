-- iam cluster — initial migration (forward-only). Hand-authored to match
-- ../src/schema (drizzle-kit generate was unavailable in the build sandbox; this
-- SQL is the exact translation and can be replaced by a regenerated set later).
--
-- Prerequisites (installed by src/migrate.ts before this runs): pg_trgm, uuidv7().

CREATE SCHEMA IF NOT EXISTS "iam";

--> statement-breakpoint
-- users -----------------------------------------------------------------------
CREATE TABLE "iam"."users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"mobile" text,
	"email" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"full_name" text,
	"deleted_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_mobile_active_uq" ON "iam"."users" ("mobile") WHERE "iam"."users"."deleted_at" IS NULL AND "iam"."users"."mobile" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_active_uq" ON "iam"."users" ("email") WHERE "iam"."users"."deleted_at" IS NULL AND "iam"."users"."email" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "iam"."users" ("status");
--> statement-breakpoint
CREATE INDEX "users_deleted_at_idx" ON "iam"."users" ("deleted_at") WHERE "iam"."users"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "users_full_name_trgm_idx" ON "iam"."users" USING gin ("full_name" gin_trgm_ops);

--> statement-breakpoint
-- credentials (1:1 users, PK = user_id) --------------------------------------
CREATE TABLE "iam"."credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamptz DEFAULT now() NOT NULL,
	"password_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iam"."credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint
-- otps ------------------------------------------------------------------------
CREATE TABLE "iam"."otps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"user_id" uuid,
	"target" text NOT NULL,
	"channel" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "otps_target_idx" ON "iam"."otps" ("target");
--> statement-breakpoint
CREATE INDEX "otps_user_idx" ON "iam"."otps" ("user_id");
--> statement-breakpoint
CREATE INDEX "otps_expires_idx" ON "iam"."otps" ("expires_at");

--> statement-breakpoint
-- devices ---------------------------------------------------------------------
CREATE TABLE "iam"."devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"user_id" uuid NOT NULL,
	"fingerprint" text,
	"platform" text,
	"last_seen_at" timestamptz
);
--> statement-breakpoint
ALTER TABLE "iam"."devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "iam"."devices" ("user_id");
--> statement-breakpoint
CREATE INDEX "devices_fingerprint_idx" ON "iam"."devices" ("fingerprint");

--> statement-breakpoint
-- sessions --------------------------------------------------------------------
CREATE TABLE "iam"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"refresh_token_hash" text NOT NULL,
	"portal_audience" text,
	"expires_at" timestamptz NOT NULL,
	"revoked_at" timestamptz
);
--> statement-breakpoint
ALTER TABLE "iam"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "iam"."sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "iam"."devices"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "iam"."sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "sessions_device_idx" ON "iam"."sessions" ("device_id");
--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "iam"."sessions" ("expires_at");
--> statement-breakpoint
CREATE INDEX "sessions_active_idx" ON "iam"."sessions" ("user_id","expires_at") WHERE "iam"."sessions"."revoked_at" IS NULL;

--> statement-breakpoint
-- roles -----------------------------------------------------------------------
CREATE TABLE "iam"."roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'platform' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_key_uq" ON "iam"."roles" ("key");
--> statement-breakpoint
CREATE INDEX "roles_scope_idx" ON "iam"."roles" ("scope");

--> statement-breakpoint
-- permissions -----------------------------------------------------------------
CREATE TABLE "iam"."permissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"key" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_key_uq" ON "iam"."permissions" ("key");

--> statement-breakpoint
-- role_permissions (composite PK) ---------------------------------------------
CREATE TABLE "iam"."role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY ("role_id","permission_id")
);
--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "iam"."permissions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "role_permissions_permission_idx" ON "iam"."role_permissions" ("permission_id");

--> statement-breakpoint
-- user_roles (surrogate id PK + COALESCE unique) ------------------------------
CREATE TABLE "iam"."user_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"org_id" uuid
);
--> statement-breakpoint
ALTER TABLE "iam"."user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "iam"."user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_user_role_org_uq" ON "iam"."user_roles" ("user_id","role_id",COALESCE("org_id", '00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "iam"."user_roles" ("user_id");
--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "iam"."user_roles" ("role_id");
--> statement-breakpoint
CREATE INDEX "user_roles_org_idx" ON "iam"."user_roles" ("org_id");

--> statement-breakpoint
-- consents --------------------------------------------------------------------
CREATE TABLE "iam"."consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"granted_at" timestamptz DEFAULT now() NOT NULL,
	"revoked_at" timestamptz
);
--> statement-breakpoint
ALTER TABLE "iam"."consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "consents_user_idx" ON "iam"."consents" ("user_id");
--> statement-breakpoint
CREATE INDEX "consents_type_idx" ON "iam"."consents" ("type");
--> statement-breakpoint
CREATE UNIQUE INDEX "consents_user_type_active_uq" ON "iam"."consents" ("user_id","type") WHERE "iam"."consents"."revoked_at" IS NULL;

--> statement-breakpoint
-- organizations ---------------------------------------------------------------
CREATE TABLE "iam"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"rera_no" text,
	"gstin" text,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "organizations_type_idx" ON "iam"."organizations" ("type");
--> statement-breakpoint
CREATE INDEX "organizations_status_idx" ON "iam"."organizations" ("status");
--> statement-breakpoint
CREATE INDEX "organizations_name_trgm_idx" ON "iam"."organizations" USING gin ("name" gin_trgm_ops);

--> statement-breakpoint
-- org_units (self-tree) -------------------------------------------------------
CREATE TABLE "iam"."org_units" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"type" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iam"."org_units" ADD CONSTRAINT "org_units_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "iam"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "org_units_org_idx" ON "iam"."org_units" ("org_id");
--> statement-breakpoint
CREATE INDEX "org_units_parent_idx" ON "iam"."org_units" ("parent_id");

--> statement-breakpoint
-- org_members -----------------------------------------------------------------
CREATE TABLE "iam"."org_members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_unit_id" uuid,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iam"."org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "iam"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "iam"."org_members" ADD CONSTRAINT "org_members_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "iam"."org_units"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "org_members_org_idx" ON "iam"."org_members" ("org_id");
--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "iam"."org_members" ("user_id");
--> statement-breakpoint
CREATE INDEX "org_members_unit_idx" ON "iam"."org_members" ("org_unit_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_org_user_uq" ON "iam"."org_members" ("org_id","user_id");

--> statement-breakpoint
-- partners --------------------------------------------------------------------
CREATE TABLE "iam"."partners" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"org_id" uuid NOT NULL,
	"category" text NOT NULL,
	"terms" jsonb
);
--> statement-breakpoint
ALTER TABLE "iam"."partners" ADD CONSTRAINT "partners_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "iam"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "partners_org_uq" ON "iam"."partners" ("org_id");
--> statement-breakpoint
CREATE INDEX "partners_category_idx" ON "iam"."partners" ("category");

--> statement-breakpoint
-- outbox (kernel factory) -----------------------------------------------------
CREATE TABLE "iam"."outbox" (
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
CREATE INDEX "outbox_unpublished_idx" ON "iam"."outbox" ("occurred_at","seq") WHERE "iam"."outbox"."published_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "iam"."outbox" ("aggregate_id");

--> statement-breakpoint
-- audit_events (kernel factory) -----------------------------------------------
CREATE TABLE "iam"."audit_events" (
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
CREATE INDEX "audit_events_entity_idx" ON "iam"."audit_events" ("entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "iam"."audit_events" ("actor_id");
--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "iam"."audit_events" ("occurred_at");
--> statement-breakpoint
CREATE INDEX "audit_events_request_idx" ON "iam"."audit_events" ("request_id");
