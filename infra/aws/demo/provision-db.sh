#!/usr/bin/env bash
# DEMO-INFRA: create (or, with RECREATE=1, drop and recreate) the demo databases and their OWN roles.
#   app box  (root): provision-db.sh app     -> alembic-pg: alembic_demo (alembic_demo_owner/_app), rawprod_demo (rawprod_demo_owner/_app)
#   vault box(root): provision-db.sh vault   -> vault-pg:   vault_demo   (vault_demo_owner/_app)
# Connects as the RDS master (secret read on-box from Secrets Manager, never printed). Passwords come from SSM
# /rawaroma/demo/<x>/DB_PASSWORD_{owner,app} and are passed to psql on stdin only.
# Isolation made here and verified at the end:
#   - CONNECT/TEMP on each demo DB is revoked from PUBLIC and granted only to that DB's two demo roles.
#   - Prod DBs (alembic, rawprod, vault) already have CONNECT revoked from PUBLIC, so demo roles cannot reach them.
#   - The master is made a member of the demo owner only for the duration of this script (needed for CREATE DATABASE ... OWNER
#     and for the non-trusted extension postgis), then the membership is revoked.
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2 PGSSLMODE=verify-full
g(){ aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text; }
case "${1:?app|vault}" in
app)   export PGHOST=alembic-pg.creos6e6ye38.us-west-2.rds.amazonaws.com PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
       SEC='arn:aws:secretsmanager:us-west-2:859485559854:secret:rds!db-f9faedbf-66ea-4e7e-b35f-03322c8d2f1a-o6VENi'
       SETS="alembic_demo:alembic_demo_owner:alembic_demo_app:alembic:pgcrypto,btree_gist rawprod_demo:rawprod_demo_owner:rawprod_demo_app:rawprod:pgcrypto,citext,pg_trgm,postgis"
       PROD="alembic_owner alembic_app rawprod_owner rawprod_app"; PRODDBS="alembic rawprod" ;;
vault) export PGHOST=vault-pg.creos6e6ye38.us-west-2.rds.amazonaws.com PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
       SEC='arn:aws:secretsmanager:us-west-2:859485559854:secret:rds!db-5dd9e408-71ab-4463-8048-d7dd0be6f125-bKf3wk'
       SETS="vault_demo:vault_demo_owner:vault_demo_app:vault:pgcrypto,citext,pg_trgm,postgis"
       PROD="ra_vault_owner ra_vault"; PRODDBS="vault" ;;
esac
eval "$(aws secretsmanager get-secret-value --secret-id "$SEC" --query SecretString --output text | python3 -c 'import json,sys,shlex;d=json.load(sys.stdin);print("export PGUSER="+shlex.quote(d["username"])+" PGPASSWORD="+shlex.quote(d["password"]))')"
Q(){ psql -X -q -v ON_ERROR_STOP=1 "$@"; }
for set in $SETS; do
  IFS=: read -r db owner app ns exts <<<"$set"
  pwo=$(g /rawaroma/demo/$ns/DB_PASSWORD_owner); pwa=$(g /rawaroma/demo/$ns/DB_PASSWORD_app)
  { printf '\\set pwo %s\n\\set pwa %s\n' "$(printf %s "$pwo" | sed "s/'/''/g; s/^/'/; s/\$/'/")" "$(printf %s "$pwa" | sed "s/'/''/g; s/^/'/; s/\$/'/")"
    cat <<SQL
SELECT format('CREATE ROLE %I LOGIN', r) FROM unnest(ARRAY['$owner','$app']) r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE $owner WITH LOGIN NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20 PASSWORD :'pwo';
ALTER ROLE $app   WITH LOGIN NOCREATEDB NOCREATEROLE CONNECTION LIMIT 30 PASSWORD :'pwa';
GRANT $owner TO CURRENT_USER;
SELECT format('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %L AND pid <> pg_backend_pid()', '$db') WHERE '${RECREATE:-0}' = '1' \gexec
SELECT format('DROP DATABASE IF EXISTS %I', '$db') WHERE '${RECREATE:-0}' = '1' \gexec
SELECT format('CREATE DATABASE %I OWNER %I', '$db', '$owner') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$db') \gexec
REVOKE ALL ON DATABASE $db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $db TO $owner, $app;
SQL
  } | Q -d postgres
  Q -d "$db" <<SQL
$(IFS=,; for e in $exts; do echo "CREATE EXTENSION IF NOT EXISTS $e;"; done)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO $app;
SQL
  Q -d postgres -c "REVOKE $owner FROM CURRENT_USER"
  echo "db $db owner=$owner app=$app ext=$exts${RECREATE:+ (recreated)}"
done
# ---- isolation proof: no prod role can CONNECT to a demo DB, no demo role can CONNECT to a prod DB
Q -d postgres -At <<SQL
SELECT 'connect '||r||' -> '||d||' = '||has_database_privilege(r, d, 'CONNECT')
FROM unnest(string_to_array('$PROD $(for s in $SETS; do IFS=: read -r _ o a _ _ <<<"$s"; printf '%s %s ' $o $a; done)', ' ')) r,
     unnest(string_to_array('$PRODDBS $(for s in $SETS; do printf '%s ' ${s%%:*}; done)', ' ')) d
WHERE r <> '' AND d <> '' ORDER BY 1;
SELECT 'master member of '||b.rolname||' = '||pg_has_role(current_user, b.rolname, 'USAGE') FROM pg_roles b WHERE b.rolname LIKE '%demo%' ORDER BY 1;
SQL
