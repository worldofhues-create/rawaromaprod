#!/usr/bin/env bash
# DEMO-INFRA: stage the demo runtime on a box (root). Idempotent. Nothing is enabled or started; no prod unit is touched.
#   app box:   install-box.sh app    (alembic-demo-{api,web,migrate}, alembic-demo-api.socket, rawprod-demo-{api,migrate},
#                                     demo origin vhost 8444/8445 enabled behind nginx -t + graceful reload)
#   vault box: install-box.sh vault  (vault-demo-{api,migrate})
# Code: P0 deploys the exact RC artifact to /srv/alembic-demo/app and /srv/rawprod-demo/app (owned by the demo users).
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
LIB=/usr/local/lib/rawaroma/demo
if [ "$D" != "$LIB" ]; then install -d "$LIB"; cp -a "$D/." "$LIB/"; chown -R root:root "$LIB"; fi
# The app box's shared http-level header buffers live beside the production vhosts (infra/aws/nginx/); staged into
# $LIB/nginx/ with the demo's own so a later run from $LIB still has it.
if [ -f "$D/../nginx/rawprod-large-headers.conf" ]; then install -m 644 "$D/../nginx/rawprod-large-headers.conf" "$LIB/nginx/rawprod-large-headers.conf"; fi
mkuser(){ id "$1" >/dev/null 2>&1 || useradd --system --home-dir "$2" --no-create-home --shell /usr/sbin/nologin "$1"; }
unit(){ install -m 644 "$LIB/systemd/$1" /etc/systemd/system/$1; systemctl disable "$1" >/dev/null 2>&1 || true; }
case "${1:?app|vault}" in
app)
  mkuser alembic-demo /srv/alembic-demo; mkuser rawprod-demo /srv/rawprod-demo
  install -d -o alembic-demo -g alembic-demo -m 750 /srv/alembic-demo /srv/alembic-demo/app /srv/alembic-demo/var /srv/alembic-demo/var/web-cache
  install -d -o rawprod-demo -g rawprod-demo -m 750 /srv/rawprod-demo /srv/rawprod-demo/app
  install -d -o alembic-demo -g alembic-demo -m 750 /var/log/alembic-demo
  install -d -o rawprod-demo -g rawprod-demo -m 750 /var/log/rawprod-demo
  for u in alembic-demo-api.socket alembic-demo-api.service alembic-demo-web.service alembic-demo-migrate.service \
           rawprod-demo-api.service rawprod-demo-migrate.service alembic-demo-aws-creds.service alembic-demo-aws-creds.timer; do unit $u; done
  systemctl daemon-reload
  "$LIB/render-demo-env.sh" app
  # demo origin vhost
  install -d -m 750 -g www-data /etc/nginx/rawaroma-demo
  s=$(aws ssm get-parameter --region us-west-2 --name /rawaroma/demo/origin-secret --with-decryption --query Parameter.Value --output text)
  t=$(mktemp /etc/nginx/rawaroma-demo/.sXXXX); printf 'set $demo_origin_secret "%s";\n' "$s" > "$t"; unset s
  chmod 640 "$t"; chown root:www-data "$t"; mv -f "$t" /etc/nginx/rawaroma-demo/origin-secret.conf
  install -d -m 755 /var/www/rawprod-demo-cf
  if [ -d /srv/rawprod-demo/app/web ] && [ -n "$(ls -A /srv/rawprod-demo/app/web)" ]; then
    t=/var/www/rawprod-demo-cf/factory; rm -rf "$t.new"; install -d "$t.new"
    tar -C /srv/rawprod-demo/app/web --exclude=./build --exclude='./.*' --exclude='*.md' -cf - . | tar -C "$t.new" -xf -
    chown -R root:root "$t.new"; chmod -R u=rwX,go=rX "$t.new"; rm -rf "$t.old"; [ -d "$t" ] && mv "$t" "$t.old"; mv "$t.new" "$t"; rm -rf "$t.old"
  else
    install -d -m 755 /var/www/rawprod-demo-cf/factory
    [ -f /var/www/rawprod-demo-cf/factory/index.html ] || printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RawProd demo</title></head><body style="font-family:system-ui;margin:3rem"><h1>RawProd demo</h1><p>Origin is up. The demo console is not deployed yet.</p></body></html>\n' > /var/www/rawprod-demo-cf/factory/index.html
  fi
  # The app box's http-level header buffers (shared with production; infra/aws/nginx/rawprod-large-headers.conf), so a
  # large RawProd owner token is never refused at nginx. Checked by the same nginx -t as the vhost below.
  install -d /etc/nginx/conf.d; install -m 644 "$LIB/nginx/rawprod-large-headers.conf" /etc/nginx/conf.d/rawprod-large-headers.conf
  install -m 644 "$LIB/nginx/rawaroma-demo-origin.conf" /etc/nginx/sites-available/rawaroma-demo-origin.conf
  ln -sf /etc/nginx/sites-available/rawaroma-demo-origin.conf /etc/nginx/sites-enabled/rawaroma-demo-origin.conf
  if nginx -t 2>&1; then systemctl reload nginx; echo "nginx reloaded"; else rm -f /etc/nginx/sites-enabled/rawaroma-demo-origin.conf; echo "nginx -t FAILED, demo vhost removed"; exit 1; fi
  ;;
vault)
  mkuser rawprod-demo /srv/rawprod-demo
  install -d -o rawprod-demo -g rawprod-demo -m 750 /srv/rawprod-demo /srv/rawprod-demo/app /var/log/rawprod-demo
  unit vault-demo-api.service; unit vault-demo-migrate.service; unit vault-demo-aws-creds.service; unit vault-demo-aws-creds.timer
  systemctl daemon-reload
  "$LIB/render-demo-env.sh" vault
  ;;
esac
systemctl list-unit-files '*demo*' --no-legend --no-pager
