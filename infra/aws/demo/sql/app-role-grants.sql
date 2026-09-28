-- DEMO-INFRA: RawProd / vault demo DML grants (their migrations name no role). Run as the demo OWNER after every
-- demo migrate, with psql -v app=<demo app role> -v skip=<schema not granted, or ''>. Idempotent.
\set ON_ERROR_STOP 1
SELECT set_config('demo.app', :'app', false), set_config('demo.skip', :'skip', false);
DO $$
DECLARE s text; app text := current_setting('demo.app'); skip text := current_setting('demo.skip');
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE (nspowner = current_user::regrole OR nspname = 'public') AND nspname <> skip LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', s, app);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', s, app);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', s, app);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', s, app);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', s, app);
  END LOOP;
END $$;
-- iam.login_history is append-only (scripts/migrations/2026-09-28-login-history.sql): the blanket grant above
-- re-hands the app role UPDATE/DELETE on it after every demo migrate, so take them back. Its trigger refuses them
-- anyway; this keeps the privileges honest too.
DO $$
DECLARE app text := current_setting('demo.app');
BEGIN
  IF to_regclass('iam.login_history') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON iam.login_history FROM %I', app);
  END IF;
END $$;
