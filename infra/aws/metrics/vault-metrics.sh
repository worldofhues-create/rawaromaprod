#!/usr/bin/env bash
# G6 unit-health metrics for the vault box (i-0edad222a96eeed07), every 5 min via vault-metrics.timer.
# A unit is only reported once it is enabled, so the staged (disabled) units do not alarm before go-live.
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2
D=""
for u in vault-api.service nginx.service; do
  systemctl is-enabled --quiet "$u" 2>/dev/null || continue
  v=0; systemctl is-active --quiet "$u" && v=1
  D="$D{\"MetricName\":\"UnitActive\",\"Dimensions\":[{\"Name\":\"Unit\",\"Value\":\"$u\"}],\"Value\":$v,\"Unit\":\"Count\"},"
done
aws cloudwatch put-metric-data --namespace RawAroma/Vault --metric-data "[$D{\"MetricName\":\"MetricsHeartbeat\",\"Value\":1,\"Unit\":\"Count\"}]"
echo ok
