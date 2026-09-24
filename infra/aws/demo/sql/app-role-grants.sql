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
