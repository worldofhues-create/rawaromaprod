#!/usr/bin/env bash
# On-box installer for lane INFRA2 (G6 metrics, G7 restore drill, env files, staged units/vhosts).
# usage (as root, from an unpacked copy of infra/aws): ./install-ops.sh app|vault
# Idempotent. Never starts or restarts rawprod-api / vault-api, never touches alembic-* units, never reloads nginx
# (it stages vhosts/snippets and, on app, conf.d/rawprod-large-headers.conf for the next nginx -t + reload):
# the only service it (re)starts is amazon-cloudwatch-agent. daemon-reload does not restart anything.
set -euo pipefail
R=${1:?app|vault}; D=$(cd "$(dirname "$0")" && pwd)
N=$([ "$R" = app ] && echo rawprod || echo vault)
# The snap-packaged aws CLI cannot run inside hardened units (snap-confine needs caps); use the official v2 bundle.
if [ ! -x /usr/local/bin/aws ]; then
  T=$(mktemp -d); curl -fsSL -o "$T/a.zip" "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip"
  python3 -c 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$T/a.zip" "$T"
  chmod -R +x "$T/aws/dist" "$T/aws/install"; "$T/aws/install" -i /usr/local/aws-cli -b /usr/local/bin >/dev/null; rm -rf "$T"
fi
install -d -o rawprod -g rawprod -m 750 /var/log/rawprod
install -d -m 755 /usr/local/lib/rawaroma
install -m 755 "$D/metrics/$N-metrics.sh" "$D/restore-drill/$N-drill.sh" "$D/env/render-env.sh" /usr/local/lib/rawaroma/
cat > /etc/logrotate.d/rawprod <<'X'
/var/log/rawprod/*.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
X
# G6/G7 timers: installed and enabled
install -m 644 "$D/metrics/$N-metrics.service" "$D/metrics/$N-metrics.timer" \
  "$D/restore-drill/$N-restore-drill.service" "$D/restore-drill/$N-restore-drill.timer" /etc/systemd/system/
# RawProd app units: installed, NOT enabled, NOT started (go-live is after H7 DNS)
if [ "$R" = app ]; then U="rawprod-api.service rawprod-migrate.service"; V=rawprod-main.conf; else U="vault-api.service vault-migrate.service"; V=vault.conf; fi
for u in $U; do install -m 644 "$D/systemd/$u" /etc/systemd/system/; done
systemctl daemon-reload
for u in $U; do systemctl disable "$u" >/dev/null 2>&1 || true; done
systemctl enable --now "$N-metrics.timer" "$N-restore-drill.timer"
# nginx vhost: staged in sites-available only (not linked into sites-enabled, no reload)
install -d /etc/nginx/sites-available
install -m 644 "$D/nginx/$V" "/etc/nginx/sites-available/$V"
install -d /etc/nginx/rawprod; [ "$R" = vault ] && install -m 644 "$D/nginx/security-headers-vault.conf" /etc/nginx/rawprod/ || true
[ "$R" = app ] && install -m 644 "$D/nginx/security-headers-factory.conf" "$D/nginx/security-headers-platform.conf" /etc/nginx/rawprod/ || true
# http-level header buffers for the app box (prod + demo): a large RawProd owner token must not lock the owner out
# at nginx (live since 2026-09-25; see the file). Installed, not reloaded -- the next nginx -t + reload picks it up.
[ "$R" = app ] && { install -d /etc/nginx/conf.d; install -m 644 "$D/nginx/rawprod-large-headers.conf" /etc/nginx/conf.d/rawprod-large-headers.conf; } || true
# env files from SSM (mode 600)
/usr/local/lib/rawaroma/render-env.sh "$R"
# CloudWatch agent
CTL=/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl
if [ ! -x "$CTL" ]; then
  A=$(dpkg --print-architecture); T=$(mktemp -d)
  curl -fsSL -o "$T/cwa.deb" "https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/$A/latest/amazon-cloudwatch-agent.deb"
  dpkg -i -E "$T/cwa.deb" >/dev/null; rm -rf "$T"
fi
install -m 644 "$D/cloudwatch/agent-$R.json" /opt/aws/amazon-cloudwatch-agent/etc/rawaroma-rawprod.json
if [ "$R" = app ]; then
  # ALEMBIC's agent config stays; this appends a second file (restarts only the agent, not alembic-*)
  $CTL -a append-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/rawaroma-rawprod.json
else
  $CTL -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/rawaroma-rawprod.json
fi
systemctl is-active amazon-cloudwatch-agent
systemctl list-timers --no-pager | grep -E "$N-(metrics|restore)" || true
echo "install-ops $R done"
