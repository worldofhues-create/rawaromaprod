#!/usr/bin/env bash
# G7 weekly restore drill for the `rawprod` database (FINAL_OS §36). rawprod shares alembic-pg with ALEMBIC,
# so an RDS snapshot/PITR restore would clone ALEMBIC too; this drill is pg_dump based instead:
#   1. pg_dump -Fc rawprod (as rawprod_owner), keep the dump in S3 under rawprod/pg_dump/ (also a logical backup)
#   2. CREATE DATABASE rawprod_drill_<ts> on alembic-pg (as the RDS master), CONNECT revoked from PUBLIC
#   3. pg_restore into it, compare the table count and every table's exact row count with the source
#   4. write the evidence JSON to s3://<backups>/restore-drills/rawprod/<ts>.json, DROP the drill DB (always, via trap)
# The source is only read. ALEMBIC's database is never touched. Runs as root (reads the master secret).
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2 PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem PGSSLMODE=verify-full
BUCKET=alembic-backups-859485559854-usw2
HOST=alembic-pg.creos6e6ye38.us-west-2.rds.amazonaws.com
MASTER_SECRET='arn:aws:secretsmanager:us-west-2:859485559854:secret:rds!db-f9faedbf-66ea-4e7e-b35f-03322c8d2f1a-o6VENi'
TS=$(date -u +%Y%m%dT%H%M%SZ); DRILL=rawprod_drill_$(date -u +%Y%m%d%H%M%S); W=$(mktemp -d); START=$(date +%s)
SRC=$(aws ssm get-parameter --name /rawaroma/rawprod/MIGRATE_DATABASE_URL --with-decryption --query Parameter.Value --output text)
SEC=$(aws secretsmanager get-secret-value --secret-id "$MASTER_SECRET" --query SecretString --output text)
export PGUSER=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["username"])' "$SEC")
export PGPASSWORD=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["password"])' "$SEC"); unset SEC
export PGHOST=$HOST
cleanup(){ psql -d postgres -XAtq -c "DROP DATABASE IF EXISTS $DRILL WITH (FORCE)" >/dev/null 2>&1 || true; rm -rf "$W"; }
trap cleanup EXIT
COUNTS="select n.nspname||'.'||c.relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema','tiger','tiger_data','topology') and n.nspname !~ '^pg_' order by 1"

pg_dump "$SRC" -Fc -f "$W/rawprod.dump"
DUMP_BYTES=$(stat -c %s "$W/rawprod.dump"); DUMP_SHA=$(sha256sum "$W/rawprod.dump" | cut -d' ' -f1)
aws s3 cp --only-show-errors --sse AES256 "$W/rawprod.dump" "s3://$BUCKET/rawprod/pg_dump/$TS.dump"
PGOPTIONS='-c default_transaction_read_only=on' psql "$SRC" -XAtq -F'|' -c "$COUNTS" > "$W/src.txt"

psql -d postgres -XAtq -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DRILL" -c "REVOKE CONNECT ON DATABASE $DRILL FROM PUBLIC"
RESTORE_RC=0; pg_restore -d "$DRILL" --no-owner --no-acl "$W/rawprod.dump" 2> "$W/restore.err" || RESTORE_RC=$?
psql -d "$DRILL" -XAtq -F'|' -c "$COUNTS" > "$W/dst.txt"
psql -d "$DRILL" -XAtq -c "select count(*) from public.schema_migrations" > "$W/ledger.txt" 2>/dev/null || echo "n/a" > "$W/ledger.txt"

python3 - "$W" "$TS" "$DRILL" "$DUMP_BYTES" "$DUMP_SHA" "$RESTORE_RC" "$START" "$BUCKET" <<'PY' > "$W/evidence.json"
import json,sys,time,socket
w,ts,drill,nb,sha,rc,start,bucket=sys.argv[1:]
rd=lambda f:dict(l.split('|',1) for l in open(f"{w}/{f}").read().split('\n') if '|' in l)
s,d=rd("src.txt"),rd("dst.txt")
mism={k:[s.get(k),d.get(k)] for k in set(s)|set(d) if s.get(k)!=d.get(k)}
# pg_restore exits 1 on benign RDS errors (e.g. COMMENT ON EXTENSION owned by rdsadmin); the data check decides
ok=not mism and len(s)>0
print(json.dumps({"drill":"rawprod","method":"pg_dump -Fc -> pg_restore into throwaway DB on alembic-pg","timestamp":ts,
 "host":socket.gethostname(),"drill_database":drill,"dump_bytes":int(nb),"dump_sha256":sha,
 "dump_s3":f"s3://{bucket}/rawprod/pg_dump/{ts}.dump","pg_restore_exit":int(rc),"tables_source":len(s),"tables_restored":len(d),
 "rows_source":sum(int(v) for v in s.values()),"rows_restored":sum(int(v) for v in d.values()),
 "ledger_rows":open(f"{w}/ledger.txt").read().strip(),"mismatches":mism,
 "restore_stderr_tail":open(f"{w}/restore.err").read()[-800:],"duration_seconds":int(time.time())-int(start),
 "result":"PASS" if ok else "FAIL","teardown":"DROP DATABASE on exit"},indent=1))
PY
aws s3 cp --only-show-errors --sse AES256 "$W/evidence.json" "s3://$BUCKET/restore-drills/rawprod/$TS.json"
RESULT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["result"])' "$W/evidence.json")
aws cloudwatch put-metric-data --namespace RawAroma/RawProd --metric-data "[{\"MetricName\":\"RestoreDrillPass\",\"Dimensions\":[{\"Name\":\"Drill\",\"Value\":\"rawprod\"}],\"Value\":$([ "$RESULT" = PASS ] && echo 1 || echo 0)}]"
echo "restore-drill rawprod $TS $RESULT evidence=s3://$BUCKET/restore-drills/rawprod/$TS.json"
[ "$RESULT" = PASS ]
