-- DEMO-INFRA: move every privilege the ALEMBIC migrations granted to the PRODUCTION role `alembic_app` inside
-- `alembic_demo` over to the demo role `alembic_demo_app`, then take it away from `alembic_app`.
-- Why: 73 ALEMBIC migrations GRANT/REVOKE on the literal role name `alembic_app`, and Postgres roles are cluster-wide,
-- so a normal `migrate:up` on alembic_demo would hand the prod role grants in the demo DB (inert, since alembic_app has
-- no CONNECT on alembic_demo, but still a shared grant). Run as alembic_demo_owner after EVERY demo migrate
-- (alembic-demo-migrate.service ExecStartPost and reset-demo.sh do). Idempotent. Fails loudly if anything is left.
\set ON_ERROR_STOP 1
DO $$
DECLARE
  src oid := 'alembic_app'::regrole; dst text := 'alembic_demo_app'; r record; roles text;
BEGIN
  -- tables, views, sequences
  FOR r IN SELECT c.oid::regclass AS obj, c.relkind, a.privilege_type AS p
           FROM pg_class c, aclexplode(c.relacl) a
           WHERE a.grantee = src AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) LOOP
    EXECUTE format('GRANT %s ON %s %s TO %I', r.p, CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.obj, dst);
    EXECUTE format('REVOKE %s ON %s %s FROM alembic_app', r.p, CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.obj);
  END LOOP;
  -- column-level grants (e.g. 0080's column-listed UPDATE)
  FOR r IN SELECT att.attrelid::regclass AS obj, att.attname AS col, a.privilege_type AS p
           FROM pg_attribute att, aclexplode(att.attacl) a
           WHERE a.grantee = src AND att.attacl IS NOT NULL LOOP
    EXECUTE format('GRANT %s (%I) ON TABLE %s TO %I', r.p, r.col, r.obj, dst);
    EXECUTE format('REVOKE %s (%I) ON TABLE %s FROM alembic_app', r.p, r.col, r.obj);
  END LOOP;
  -- schemas
  FOR r IN SELECT n.nspname AS obj, a.privilege_type AS p FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = src LOOP
    EXECUTE format('GRANT %s ON SCHEMA %I TO %I', r.p, r.obj, dst);
    EXECUTE format('REVOKE %s ON SCHEMA %I FROM alembic_app', r.p, r.obj);
  END LOOP;
  -- functions / procedures
  FOR r IN SELECT p.oid::regprocedure AS obj, a.privilege_type AS p FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = src LOOP
    EXECUTE format('GRANT %s ON ROUTINE %s TO %I', r.p, r.obj, dst);
    EXECUTE format('REVOKE %s ON ROUTINE %s FROM alembic_app', r.p, r.obj);
  END LOOP;
  -- types / domains
  FOR r IN SELECT t.oid::regtype AS obj, a.privilege_type AS p FROM pg_type t, aclexplode(t.typacl) a WHERE a.grantee = src LOOP
    EXECUTE format('GRANT %s ON TYPE %s TO %I', r.p, r.obj, dst);
    EXECUTE format('REVOKE %s ON TYPE %s FROM alembic_app', r.p, r.obj);
  END LOOP;
  -- default privileges
  FOR r IN SELECT d.defaclrole::regrole AS forrole, d.defaclnamespace AS ns, d.defaclobjtype AS t, a.privilege_type AS p
           FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = src LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %s %s GRANT %s ON %s TO %I', r.forrole,
      CASE WHEN r.ns = 0 THEN '' ELSE format('IN SCHEMA %I', r.ns::regnamespace) END, r.p,
      CASE r.t WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END, dst);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %s %s REVOKE %s ON %s FROM alembic_app', r.forrole,
      CASE WHEN r.ns = 0 THEN '' ELSE format('IN SCHEMA %I', r.ns::regnamespace) END, r.p,
      CASE r.t WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END);
  END LOOP;
  -- RLS policies addressed TO alembic_app
  FOR r IN SELECT pol.polname, pol.polrelid::regclass AS obj, pol.polroles FROM pg_policy pol WHERE src = ANY (pol.polroles) LOOP
    SELECT string_agg(CASE WHEN x = src THEN quote_ident(dst) ELSE quote_ident(x::regrole::text) END, ', ') INTO roles FROM unnest(r.polroles) x;
    EXECUTE format('ALTER POLICY %I ON %s TO %s', r.polname, r.obj, roles);
  END LOOP;
  -- nothing may remain
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = src)
  OR EXISTS (SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a WHERE a.grantee = src)
  OR EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = src)
  OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = src)
  OR EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = src)
  OR EXISTS (SELECT 1 FROM pg_policy p WHERE src = ANY (p.polroles)) THEN
    RAISE EXCEPTION 'alembic_app still holds privileges in %', current_database();
  END IF;
END $$;
