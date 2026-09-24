#!/usr/bin/env bash
# G7 weekly restore drill for vault-pg (FINAL_OS §36). Runs on the vault box (role rawprod-vault-app, policy vault-ops).
#   1. restore-db-instance-to-point-in-time --use-latest-restorable-time -> vault-drill-<ts> (single-AZ db.t4g.micro,
#      same private subnet group, SG and parameter group; storage stays on the vault-storage CMK)
#   2. connect as ra_vault_owner (the restored copy keeps the source's roles), compare the table count and every
#      table's exact row count with live vault-pg
#   3. evidence JSON -> s3://<backups>/restore-drills/vault/<ts>.json; delete the drill instance (always, via trap),
#      skip-final-snapshot and delete-automated-backups
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2 PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem PGSSLMODE=verify-full
BUCKET=alembic-backups-859485559854-usw2
TS=$(date -u +%Y%m%dT%H%M%SZ); ID=vault-drill-$(date -u +%Y%m%d%H%M); W=$(mktemp -d); START=$(date +%s)
SRC=$(aws ssm get-parameter --name /rawaroma/vault/MIGRATE_FORMULA_DATABASE_URL --with-decryption --query Parameter.Value --output text)
cleanup(){ aws rds delete-db-instance --db-instance-identifier "$ID" --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1 || true; rm -rf "$W"; }
trap cleanup EXIT
RT=$(aws rds describe-db-instances --db-instance-identifier vault-pg --query 'DBInstances[0].LatestRestorableTime' --output text)
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier vault-pg --target-db-instance-identifier "$ID" \
  --use-latest-restorable-time --db-instance-class db.t4g.micro --no-multi-az --no-publicly-accessible \
  --db-subnet-group-name rawprod-vault-private --vpc-security-group-ids sg-05d6f9f3bbdac6404 \
  --db-parameter-group-name rawprod-vault-pg16 --no-deletion-protection --backup-retention-period 0 \
  --tags Key=Project,Value=rawaroma Key=Component,Value=vault Key=Purpose,Value=restore-drill >/dev/null
aws rds wait db-instance-available --db-instance-identifier "$ID" || aws rds wait db-instance-available --db-instance-identifier "$ID"
EP=$(aws rds describe-db-instances --db-instance-identifier "$ID" --query 'DBInstances[0].Endpoint.Address' --output text)
READY=$(date +%s)
DST=$(python3 -c 'import sys,urllib.parse as u;p=u.urlsplit(sys.argv[1]);h=p.hostname;print(sys.argv[1].replace("@"+h,"@"+sys.argv[2],1))' "$SRC" "$EP")
COUNTS="select n.nspname||'.'||c.relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema','tiger','tiger_data','topology') and n.nspname !~ '^pg_' order by 1"
PGOPTIONS='-c default_transaction_read_only=on' psql "$SRC" -XAtq -F'|' -c "$COUNTS" > "$W/src.txt"
psql "$DST" -XAtq -F'|' -c "$COUNTS" > "$W/dst.txt"
SSL=$(psql "$DST" -XAtq -c "select ssl from pg_stat_ssl where pid=pg_backend_pid()")
python3 - "$W" "$TS" "$ID" "$RT" "$START" "$READY" "$BUCKET" "$SSL" <<'PY' > "$W/evidence.json"
import json,sys,time
w,ts,iid,rt,start,ready,bucket,ssl=sys.argv[1:]
rd=lambda f:dict(l.split('|',1) for l in open(f"{w}/{f}").read().split('\n') if '|' in l)
s,d=rd("src.txt"),rd("dst.txt")
# rows written to live vault-pg after the restore point legitimately differ; a restored count above live is a failure
mism={k:[s.get(k),d.get(k)] for k in set(s)|set(d) if s.get(k)!=d.get(k)}
ok=len(s)>0 and set(s)==set(d) and all(int(d[k])<=int(s[k]) for k in s)
print(json.dumps({"drill":"vault-pg","method":"RDS PITR (latest restorable time) into throwaway instance","timestamp":ts,
 "drill_instance":iid,"restore_point":rt,"minutes_to_available":round((int(ready)-int(start))/60,1),"ssl":ssl,
 "tables_source":len(s),"tables_restored":len(d),"rows_source":sum(int(v) for v in s.values()),
 "rows_restored":sum(int(v) for v in d.values()),"row_differences":mism,
 "duration_seconds":int(time.time())-int(start),"result":"PASS" if ok else "FAIL",
 "teardown":"delete-db-instance --skip-final-snapshot --delete-automated-backups on exit"},indent=1))
PY
aws s3 cp --only-show-errors --sse AES256 "$W/evidence.json" "s3://$BUCKET/restore-drills/vault/$TS.json"
RESULT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["result"])' "$W/evidence.json")
aws cloudwatch put-metric-data --namespace RawAroma/Vault --metric-data "[{\"MetricName\":\"RestoreDrillPass\",\"Dimensions\":[{\"Name\":\"Drill\",\"Value\":\"vault-pg\"}],\"Value\":$([ "$RESULT" = PASS ] && echo 1 || echo 0)}]"
echo "restore-drill vault $TS $RESULT evidence=s3://$BUCKET/restore-drills/vault/$TS.json"
[ "$RESULT" = PASS ]
