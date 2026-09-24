#!/usr/bin/env bash
# On the app box (root): enable the CloudFront origin vhost (8443) with a static placeholder + /healthz.
# Safe for ALEMBIC: `nginx -t` gates a graceful reload (no restart); on any failure the vhost link is removed.
set -euo pipefail
D=$(cd "$(dirname "$0")/.." && pwd)
install -d /etc/nginx/rawprod /var/www/rawprod-cf
install -m 644 "$D/nginx/security-headers-factory.conf" "$D/nginx/security-headers-platform.conf" /etc/nginx/rawprod/
"$D/cloudfront/render-origin-secret.sh"
[ -f /var/www/rawprod-cf/index.html ] || cat > /var/www/rawprod-cf/index.html <<'H'
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RawProd</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui;margin:3rem"><h1>RawProd</h1><p>Origin is up. The console is not deployed yet.</p></body></html>
H
install -m 644 "$D/nginx/rawprod-cf-origin.conf" /etc/nginx/sites-available/rawprod-cf-origin.conf
ln -sf /etc/nginx/sites-available/rawprod-cf-origin.conf /etc/nginx/sites-enabled/rawprod-cf-origin.conf
if nginx -t 2>&1; then systemctl reload nginx; else rm -f /etc/nginx/sites-enabled/rawprod-cf-origin.conf; echo "nginx -t FAILED, vhost removed"; exit 1; fi
