#!/usr/bin/env bash
# G6 monitoring as code (FINAL_OS §36). Idempotent: every call is a create-or-update (put-*), safe to re-run.
# Run from an operator laptop: AWS_PROFILE=rawaroma ./infra/aws/cloudwatch/apply.sh
# Creates: SNS topic rawprod-alerts (+ 2 email subscriptions, the recipients must click Confirm), log groups
# /rawaroma/rawprod/*, CloudTrail trail rawaroma-audit -> S3 + CloudWatch Logs, the KMS envelope-key Decrypt-error
# metric filter, and every alarm below. alembic-pg's own alarms (alembic-rds-*) are left untouched.
set -euo pipefail
export AWS_REGION=${AWS_REGION:-us-west-2} AWS_USE_DUALSTACK_ENDPOINT=true
ACCT=859485559854; R=$AWS_REGION
TOPIC_NAME=rawprod-alerts; EMAILS="almaskhanraw@gmail.com avinandan.toc@gmail.com"
VAULT_EC2=i-0edad222a96eeed07; VAULT_DB=vault-pg; APP_DB=alembic-pg
ENVELOPE_KEY=arn:aws:kms:$R:$ACCT:key/83c66cf8-c125-4574-a889-584ecedf154c
TRAIL=rawaroma-audit; TRAIL_BUCKET=rawaroma-cloudtrail-$ACCT-usw2; TRAIL_LG=/rawaroma/cloudtrail; TRAIL_ROLE=rawaroma-cloudtrail-to-cwl
TAGS="Key=Project,Value=rawaroma Key=Component,Value=rawprod"

# ---- SNS
TOPIC=$(aws sns create-topic --name $TOPIC_NAME --tags $TAGS --query TopicArn --output text)
EXIST=$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --query 'Subscriptions[].Endpoint' --output text)
for e in $EMAILS; do grep -qw "$e" <<<"$EXIST" || aws sns subscribe --topic-arn "$TOPIC" --protocol email --notification-endpoint "$e" >/dev/null; done

# ---- Log groups (the CloudWatch agent also creates them; pre-creating pins retention)
for g in api vault-api metrics restore-drill vault-nginx-error vault-nginx-access; do
  aws logs create-log-group --log-group-name /rawaroma/rawprod/$g --tags Project=rawaroma 2>/dev/null || true
  aws logs put-retention-policy --log-group-name /rawaroma/rawprod/$g --retention-in-days $([ $g = restore-drill ] && echo 90 || echo 30)
done

# ---- CloudTrail: one single-region trail, management events only (the first copy is free), to S3 (90-day
# lifecycle) and to CloudWatch Logs (30-day retention) so the KMS metric filter can see Decrypt errors.
aws s3api head-bucket --bucket $TRAIL_BUCKET 2>/dev/null || aws s3api create-bucket --bucket $TRAIL_BUCKET \
  --create-bucket-configuration LocationConstraint=$R >/dev/null
aws s3api put-public-access-block --bucket $TRAIL_BUCKET --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket $TRAIL_BUCKET --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-lifecycle-configuration --bucket $TRAIL_BUCKET --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-90d","Status":"Enabled","Filter":{},"Expiration":{"Days":90}}]}'
aws s3api put-bucket-tagging --bucket $TRAIL_BUCKET --tagging 'TagSet=[{Key=Project,Value=rawaroma}]'
aws s3api put-bucket-policy --bucket $TRAIL_BUCKET --policy "$(cat <<P
{"Version":"2012-10-17","Statement":[
{"Sid":"AclCheck","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:GetBucketAcl","Resource":"arn:aws:s3:::$TRAIL_BUCKET","Condition":{"StringEquals":{"aws:SourceArn":"arn:aws:cloudtrail:$R:$ACCT:trail/$TRAIL"}}},
{"Sid":"Write","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:PutObject","Resource":"arn:aws:s3:::$TRAIL_BUCKET/AWSLogs/$ACCT/*","Condition":{"StringEquals":{"s3:x-amz-acl":"bucket-owner-full-control","aws:SourceArn":"arn:aws:cloudtrail:$R:$ACCT:trail/$TRAIL"}}},
{"Sid":"TLSOnly","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::$TRAIL_BUCKET","arn:aws:s3:::$TRAIL_BUCKET/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}
P
)"
aws logs create-log-group --log-group-name $TRAIL_LG --tags Project=rawaroma 2>/dev/null || true
aws logs put-retention-policy --log-group-name $TRAIL_LG --retention-in-days 30
aws iam get-role --role-name $TRAIL_ROLE >/dev/null 2>&1 || aws iam create-role --role-name $TRAIL_ROLE --tags $TAGS \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws iam put-role-policy --role-name $TRAIL_ROLE --policy-name to-cwl --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"arn:aws:logs:$R:$ACCT:log-group:$TRAIL_LG:log-stream:*\"}]}"
LGARN="arn:aws:logs:$R:$ACCT:log-group:$TRAIL_LG:*"; ROLEARN="arn:aws:iam::$ACCT:role/$TRAIL_ROLE"
if aws cloudtrail get-trail --name $TRAIL >/dev/null 2>&1; then
  aws cloudtrail update-trail --name $TRAIL --s3-bucket-name $TRAIL_BUCKET --no-is-multi-region-trail --enable-log-file-validation \
    --cloud-watch-logs-log-group-arn "$LGARN" --cloud-watch-logs-role-arn "$ROLEARN" >/dev/null
else
  for i in 1 2 3 4 5 6; do # a new IAM role takes a few seconds to become assumable by CloudTrail
    aws cloudtrail create-trail --name $TRAIL --s3-bucket-name $TRAIL_BUCKET --no-is-multi-region-trail --enable-log-file-validation \
      --cloud-watch-logs-log-group-arn "$LGARN" --cloud-watch-logs-role-arn "$ROLEARN" --tags-list Key=Project,Value=rawaroma >/dev/null && break
    sleep 10; done
fi
aws cloudtrail put-event-selectors --trail-name $TRAIL --event-selectors \
  '[{"ReadWriteType":"All","IncludeManagementEvents":true,"DataResources":[]}]' >/dev/null
aws cloudtrail start-logging --name $TRAIL

# ---- KMS: failed Decrypt calls against the vault envelope key
aws logs put-metric-filter --log-group-name $TRAIL_LG --filter-name kms-envelope-decrypt-errors \
  --filter-pattern "{ (\$.eventSource = \"kms.amazonaws.com\") && (\$.eventName = \"Decrypt\") && (\$.errorCode = \"*\") && (\$.resources[0].ARN = \"$ENVELOPE_KEY\") }" \
  --metric-transformations metricName=EnvelopeKeyDecryptErrors,metricNamespace=RawAroma/Security,metricValue=1,defaultValue=0

# ---- Alarms. alarm NAME NS METRIC DIMS STAT PERIOD EVALS OP THRESHOLD MISSING [DESC]
alarm(){ local n=$1 ns=$2 m=$3 dims=$4 st=$5 p=$6 e=$7 op=$8 th=$9 miss=${10} d=${11:-}
  local dimarg=(); [ -n "$dims" ] && dimarg=(--dimensions $dims)
  aws cloudwatch put-metric-alarm --alarm-name "$n" --alarm-description "${d:-$n} (lane INFRA2, infra/aws/cloudwatch/apply.sh)" \
    --namespace "$ns" --metric-name "$m" ${dimarg[@]+"${dimarg[@]}"} --statistic "$st" --period "$p" --evaluation-periods "$e" \
    --datapoints-to-alarm "$e" --comparison-operator "$op" --threshold "$th" --treat-missing-data "$miss" \
    --alarm-actions "$TOPIC" --ok-actions "$TOPIC" --tags $TAGS; echo "alarm $n"; }
GT=GreaterThanThreshold; GE=GreaterThanOrEqualToThreshold; LT=LessThanThreshold
VD="Name=DBInstanceIdentifier,Value=$VAULT_DB"; VE="Name=InstanceId,Value=$VAULT_EC2"
alarm rawprod-vault-pg-cpu           AWS/RDS CPUUtilization      "$VD" Average 300 3 $GT 80  missing
alarm rawprod-vault-pg-free-storage  AWS/RDS FreeStorageSpace    "$VD" Minimum 300 2 $LT 4294967296 missing "vault-pg free storage < 4 GiB (autoscaling to 100 GiB should prevent this)"
alarm rawprod-vault-pg-connections   AWS/RDS DatabaseConnections "$VD" Maximum 300 2 $GT 60  missing "vault-pg connections > 60 (db.t4g.micro max_connections ~81)"
alarm rawprod-vault-pg-memory        AWS/RDS FreeableMemory      "$VD" Minimum 300 3 $LT 41943040 missing "vault-pg freeable memory < 40 MiB (a t4g.micro idles at ~75 MiB)"
alarm rawprod-vault-ec2-status-check AWS/EC2 StatusCheckFailed   "$VE" Maximum 60 2 $GE 1 breaching
alarm rawprod-vault-ec2-cpu          AWS/EC2 CPUUtilization      "$VE" Average 300 3 $GT 80 missing
alarm rawprod-vault-ec2-disk         RawAroma/Host disk_used_percent "$VE Name=path,Value=/ Name=device,Value=nvme0n1p1 Name=fstype,Value=ext4" Maximum 300 1 $GT 85 missing
alarm rawprod-db-size                RawAroma/RawProd DatabaseSizeBytes "" Maximum 3600 1 $GT 5368709120 missing "rawprod database > 5 GiB (it shares alembic-pg's 20 GiB)"
alarm rawprod-kms-envelope-decrypt-errors RawAroma/Security EnvelopeKeyDecryptErrors "" Sum 300 1 $GE 1 notBreaching "Failed kms:Decrypt on the vault envelope CMK (CloudTrail)"
alarm rawprod-api-unit-down          RawAroma/RawProd UnitActive "Name=Unit,Value=rawprod-api.service" Minimum 300 2 $LT 1 notBreaching "rawprod-api.service enabled but not active"
alarm rawprod-vault-api-unit-down    RawAroma/Vault   UnitActive "Name=Unit,Value=vault-api.service" Minimum 300 2 $LT 1 notBreaching "vault-api.service enabled but not active"
alarm rawprod-bridge-backlog-age     RawAroma/RawProd BridgeBacklogOldestAgeSeconds "" Maximum 300 2 $GT 900 notBreaching "oldest unpublished bridge.outbox row > 15 min"
alarm rawprod-outbox-backlog-age     RawAroma/RawProd OutboxBacklogOldestAgeSeconds "" Maximum 300 3 $GT 1800 notBreaching "oldest unpublished row in any outbox > 30 min"
alarm rawprod-dead-letters           RawAroma/RawProd DeadLetterCount "" Maximum 300 1 $GE 1 notBreaching "outbox rows with attempts>=5 plus parked bridge.inbound_event"
alarm rawprod-qc-hold-age            RawAroma/RawProd QcHoldOldestAgeHours "" Maximum 3600 1 $GT 48 notBreaching "a QC hold older than 48 h"
alarm rawprod-overdue-pr             RawAroma/RawProd OverduePurchaseRequests "" Maximum 3600 1 $GE 1 notBreaching "open PR past expected_delivery_date"
alarm rawprod-overdue-po             RawAroma/RawProd OverduePurchaseOrders "" Maximum 3600 1 $GE 1 notBreaching "open PO whose PR is past expected_delivery_date"
alarm rawprod-metrics-heartbeat      RawAroma/RawProd MetricsHeartbeat "" SampleCount 900 1 $LT 1 breaching "rawprod-metrics.timer stopped publishing"
alarm rawprod-vault-metrics-heartbeat RawAroma/Vault  MetricsHeartbeat "" SampleCount 900 1 $LT 1 breaching "vault-metrics.timer stopped publishing"
alarm rawprod-restore-drill-failed   RawAroma/RawProd RestoreDrillPass "Name=Drill,Value=rawprod" Minimum 604800 1 $LT 1 notBreaching "weekly rawprod restore drill failed"
alarm rawprod-vault-restore-drill-failed RawAroma/Vault RestoreDrillPass "Name=Drill,Value=vault-pg" Minimum 604800 1 $LT 1 notBreaching "weekly vault-pg restore drill failed"

# rawprod DB-size growth: > 256 MiB in one day (metric math on the custom size metric)
aws cloudwatch put-metric-alarm --alarm-name rawprod-db-size-growth --alarm-description "rawprod DB grew > 256 MiB in 24 h (lane INFRA2)" \
  --evaluation-periods 1 --datapoints-to-alarm 1 --comparison-operator GreaterThanThreshold --threshold 268435456 --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC" --tags $TAGS --metrics '[
   {"Id":"s","ReturnData":false,"MetricStat":{"Metric":{"Namespace":"RawAroma/RawProd","MetricName":"DatabaseSizeBytes"},"Period":86400,"Stat":"Maximum"}},
   {"Id":"g","ReturnData":true,"Label":"growth per day","Expression":"DIFF(s)"}]'; echo "alarm rawprod-db-size-growth"
echo "topic $TOPIC"
aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --query 'Subscriptions[].[Endpoint,SubscriptionArn]' --output text
