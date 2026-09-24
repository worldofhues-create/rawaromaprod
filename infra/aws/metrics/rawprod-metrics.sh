#!/usr/bin/env bash
# G6 custom metrics for RawProd (FINAL_OS §36). Runs on the app box (i-04e7dc4e5edcc1ff7) every 5 min
# via rawprod-metrics.timer. Read-only: every query runs in a read-only transaction. Publishes to
# namespace RawAroma/RawProd. Secrets are read from SSM at runtime and never echoed.
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2 PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem PGSSLMODE=verify-full
NS=RawAroma/RawProd
URL=$(aws ssm get-parameter --name /rawaroma/rawprod/MIGRATE_DATABASE_URL --with-decryption --query Parameter.Value --output text)
q(){ PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=20000' psql "$URL" -XAtq -c "$1"; }

# Sum over every <schema>.outbox table, so a new cluster outbox is picked up automatically.
OUTBOXES=$(q "select string_agg(format('select %L as s, published_at, attempts, occurred_at from %I.outbox', table_schema, table_schema), ' union all ') from information_schema.tables where table_name='outbox' and table_schema not in ('pg_catalog','information_schema')")
read -r BR_BACKLOG BR_AGE ALL_BACKLOG ALL_AGE DLQ_OUT <<<"$(q "with o as ($OUTBOXES) select
  count(*) filter (where s='bridge' and published_at is null),
  coalesce(extract(epoch from now()-min(occurred_at) filter (where s='bridge' and published_at is null)),0)::bigint,
  count(*) filter (where published_at is null),
  coalesce(extract(epoch from now()-min(occurred_at) filter (where published_at is null)),0)::bigint,
  count(*) filter (where published_at is null and attempts >= 5) from o" | tr '|' ' ')"
# Inbound bridge events the importer parked (the bridge's dead-letter set).
PARKED=$(q "select count(*) from bridge.inbound_event where parked_reason is not null and processed_at is null")
# QC hold: inspections still pending/on hold, and HOLD dispositions not yet closed/released.
read -r QC_N QC_AGE_H <<<"$(q "with h as (
  select created_dt from quality.qc_inspections where upper(coalesce(status,'')) ~ '(PENDING|HOLD|IN_PROGRESS|QUARANTINE)'
  union all select d.created_dt from quality.qc_disposition d
   where upper(coalesce(d.disposition_code,'')) ~ 'HOLD' and upper(coalesce(d.status,'')) !~ '(CLOSED|RELEASED|CANCEL|INACTIVE)')
  select count(*), coalesce(round(extract(epoch from now()-min(created_dt))/3600.0,1),0) from h" | tr '|' ' ')"
DONE='(CLOSED|CANCEL|REJECT|COMPLETE|CONVERTED|RECEIVED$|INACTIVE)'
PR_OVERDUE=$(q "select count(*) from procurement.purchase_request where expected_delivery_date < current_date and upper(coalesce(status,'')) !~ '$DONE' and upper(coalesce(status,'')) !~ '(PO_|ORDERED)'")
PO_OVERDUE=$(q "select count(*) from procurement.purchase_order po join procurement.purchase_request pr using (purchase_request_id)
  where pr.expected_delivery_date < current_date and upper(coalesce(po.status,'')) !~ '$DONE'")
DBSIZE=$(q "select pg_database_size(current_database())")

unit(){ # 1 = active, 0 = enabled but not active; not published while the unit is still staged (disabled)
  local u=$1; systemctl is-enabled --quiet "$u" 2>/dev/null || return 0
  local v=0; systemctl is-active --quiet "$u" && v=1
  echo "{\"MetricName\":\"UnitActive\",\"Dimensions\":[{\"Name\":\"Unit\",\"Value\":\"$u\"}],\"Value\":$v,\"Unit\":\"Count\"},"; }

DATA="[$(unit rawprod-api.service)
{\"MetricName\":\"BridgeBacklog\",\"Value\":$BR_BACKLOG,\"Unit\":\"Count\"},
{\"MetricName\":\"BridgeBacklogOldestAgeSeconds\",\"Value\":$BR_AGE,\"Unit\":\"Seconds\"},
{\"MetricName\":\"OutboxBacklog\",\"Value\":$ALL_BACKLOG,\"Unit\":\"Count\"},
{\"MetricName\":\"OutboxBacklogOldestAgeSeconds\",\"Value\":$ALL_AGE,\"Unit\":\"Seconds\"},
{\"MetricName\":\"DeadLetterCount\",\"Value\":$((DLQ_OUT + PARKED)),\"Unit\":\"Count\"},
{\"MetricName\":\"QcHoldCount\",\"Value\":$QC_N,\"Unit\":\"Count\"},
{\"MetricName\":\"QcHoldOldestAgeHours\",\"Value\":$QC_AGE_H,\"Unit\":\"None\"},
{\"MetricName\":\"OverduePurchaseRequests\",\"Value\":$PR_OVERDUE,\"Unit\":\"Count\"},
{\"MetricName\":\"OverduePurchaseOrders\",\"Value\":$PO_OVERDUE,\"Unit\":\"Count\"},
{\"MetricName\":\"DatabaseSizeBytes\",\"Value\":$DBSIZE,\"Unit\":\"Bytes\"},
{\"MetricName\":\"MetricsHeartbeat\",\"Value\":1,\"Unit\":\"Count\"}]"
aws cloudwatch put-metric-data --namespace "$NS" --metric-data "$DATA"
echo "ok bridge=$BR_BACKLOG/${BR_AGE}s outbox=$ALL_BACKLOG dlq=$((DLQ_OUT+PARKED)) qc=$QC_N/${QC_AGE_H}h pr_overdue=$PR_OVERDUE po_overdue=$PO_OVERDUE db=$DBSIZE"
