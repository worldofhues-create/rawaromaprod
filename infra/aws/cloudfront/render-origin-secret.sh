#!/usr/bin/env bash
# Renders /etc/nginx/rawprod/cf-origin-secret.conf from SSM /rawaroma/rawprod/cf-origin-secret (value never printed).
# Rotation: put a new SSM value, run this, `nginx -t && systemctl reload nginx`, then re-run apply.sh (CloudFront header).
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2
V=$(aws ssm get-parameter --name /rawaroma/rawprod/cf-origin-secret --with-decryption --query Parameter.Value --output text)
install -d /etc/nginx/rawprod; umask 027; T=$(mktemp /etc/nginx/rawprod/.cfXXXX)
printf 'set $rawprod_cf_secret "%s";\n' "$V" > "$T"
chown root:www-data "$T"; chmod 640 "$T"; mv -f "$T" /etc/nginx/rawprod/cf-origin-secret.conf; echo rendered cf-origin-secret.conf
