-- Migration: 2026-09-24-tutorial-system (ticket G4 — in-app tutorial engine for the factory
-- (web/), platform (web-platform/) and vault (web-vault/) consoles, behavior ported from
-- ALEMBIC's tutorial_progress design — packages/db/migrations/0135_tutorial_progress.sql in
-- that sibling repo).
--
-- ADDITIVE + IDEMPOTENT ONLY: `create table if not exists` + a guarded `DO $$ ... $$` for the
-- unique constraint. Safe to run against a fresh db:push'd database or an already-live one.
--
-- Single target (main) — the tutorial-progress table lives in the shared `platform` schema
-- (already provisioned by scripts/migrations/0002_platform.sql), on the SAME connection as
-- every other non-formula schema. It is never provisioned on the isolated formula/vault
-- connection (scripts/db-schema-groups.ts) — the vault console (web-vault) gets a static,
-- read-only how-to panel with no server-backed progress at all (see web-vault/vault.js's own
-- header: no fetch, no storage, formula data never leaves the page).
--
-- Tenancy shape: this backend is single-tenant (RawProd/RAC itself — see
-- backend/api/src/platform-ops/platform-ops.service.ts's own doc comment), so — matching every
-- other table in this schema — there is no tenant_id/org_id column here. `user_id` is this
-- table's only actor reference, FK'd to iam.user_master(user_id) exactly like
-- iam.vault_role_grant_request does in the 2026-09-24-ui-parity migration.
--
-- @target: main
CREATE TABLE IF NOT EXISTS platform.tutorial_progress (
  tutorial_progress_id uuid PRIMARY KEY DEFAULT uuidv7(),
  -- the staff member this progress row belongs to (iam.user_master.user_id — this backend's
  -- stable user identity; see backend/cluster-identity + backend/backend-kernel/src/edge/
  -- principal.ts's AuthPrincipal.userId, which is exactly this column).
  user_id uuid NOT NULL REFERENCES iam.user_master (user_id),
  -- tutorial TRACK — the workspace group the lesson belongs to (procurement|receiving|
  -- warehouse|qc|production|packaging|dispatch|platform — see backend/api/src/tutorial/
  -- tutorial-lessons.ts TUTORIAL_TRACKS). Deliberately NOT the same enum as iam.role_master's
  -- role_code: "dispatch" is the sales role's dispatch workflow and "platform" is
  -- platform_super_admin's console — both real backend roles, renamed here to the workspace
  -- concept the tutorial UI actually presents.
  role varchar(60) NOT NULL,
  -- lesson id from the registry (backend/api/src/tutorial/tutorial-lessons.ts). Never a reserved
  -- sentinel today (RawProd's WelcomePanel-equivalent targets a real lesson id directly, unlike
  -- ALEMBIC's `__welcome__` — see TutorialService's doc comment) but stored as text so a future
  -- sentinel value needs no schema change.
  lesson_id varchar(120) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'not_started',
  step_index integer NOT NULL DEFAULT 0,
  -- the lesson's `version` at the time this row was last written — the server always compares
  -- this against the CURRENT registry version server-side (never trusts the client's copy) and
  -- rejects a stale client write with 409 TUTORIAL_STALE_VERSION (TutorialService.applyEvent).
  tutorial_version integer NOT NULL DEFAULT 1,
  started_at timestamptz,
  completed_at timestamptz,
  last_seen_at timestamptz,
  created_dt timestamptz NOT NULL DEFAULT now(),
  updated_dt timestamptz NOT NULL DEFAULT now(),
  created_by varchar(255),
  updated_by varchar(255)
);

-- one row per (user, track, lesson) — POST /v1/tutorial/progress/:lessonId upserts on this key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tutorial_progress_user_role_lesson_uq'
  ) THEN
    ALTER TABLE platform.tutorial_progress
      ADD CONSTRAINT tutorial_progress_user_role_lesson_uq UNIQUE (user_id, role, lesson_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tutorial_progress_user_idx ON platform.tutorial_progress (user_id);
