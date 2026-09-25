#!/usr/bin/env bash
# Refresh the static RawProd console roots the app box's nginx serves, and (re)install their per-deployment
# browser config. Recorded from live 2026-09-25 (lane cfg-rp): each root is the checkout's web tree copied with
# the same excludes install-origin.sh / install-box.sh use, and the vault root also carries vault-config.js.
#
#   install-static.sh prod   /srv/rawprod/app/{web,web-platform,web-vault}      -> /var/www/rawprod-cf/{factory,platform,vault}
#   install-static.sh demo   /srv/rawprod-demo/app/{web,web-platform,web-vault} -> /var/www/rawprod-demo-cf/{factory,platform,vault}
#
#   static-config/{prod|demo}/console-config.js   -> /var/www/rawprod-config/{prod|demo}/console-config.js
#   static-config/{vault|demo-vault}/vault-config.js -> <vault root>/vault-config.js
#
# vault-config.js sits INSIDE the vault root (rawvault.conf / rawdemovault.conf serve it by try_files from there),
# so it is written into the new tree before the swap: a refresh that dropped it would leave the Vault console with
# no `/main` sign-in channel. Static files only: no nginx config, no reload (nginx serves the new files at once),
# no unit, no env. Each root is swapped whole (.new -> rename), so no request sees a half-copied tree, and a
# missing or empty source tree refuses rather than replacing a live root with nothing.
# Run as root on the app box, from the checkout whose web trees are being published.
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
# Test-only sandbox prefix (backend/api/src/__tests__/infra-live-capture.test.ts). Empty on a box.
R="${RAWPROD_STATIC_PREFIX:-}"
case "${1:-}" in
  prod) SRC="$R/srv/rawprod/app";      WWW="$R/var/www/rawprod-cf";      CC=prod; VC=vault ;;
  demo) SRC="$R/srv/rawprod-demo/app"; WWW="$R/var/www/rawprod-demo-cf"; CC=demo; VC=demo-vault ;;
  *) echo "usage: $0 prod|demo" >&2; exit 2 ;;
esac
for f in "$D/static-config/$CC/console-config.js" "$D/static-config/$VC/vault-config.js"; do
  [ -s "$f" ] || { echo "install-static: $f is missing; refusing to publish a console without its config" >&2; exit 1; }
done
own(){ if [ "$(id -u)" = 0 ]; then chown -R root:root "$1"; fi; chmod -R u=rwX,go=rX "$1"; }
install -d -m 755 "$WWW"
for pair in web:factory web-platform:platform web-vault:vault; do
  s="$SRC/${pair%%:*}"; t="$WWW/${pair##*:}"
  if [ ! -d "$s" ] || [ -z "$(ls -A "$s")" ]; then
    echo "install-static: $s is missing or empty; refusing to replace $t with nothing" >&2; exit 1
  fi
  rm -rf "$t.new"; install -d "$t.new"
  # The excludes install-origin.sh / install-box.sh give GNU tar (`--exclude=./build --exclude='./.*'
  # --exclude='*.md'`: top-level build/ and dotfiles, *.md at any depth), spelled out so the result does not
  # depend on which tar is installed (bsdtar reads './.*' as matching the root itself and copies nothing).
  cp -a "$s/." "$t.new/"
  rm -rf "$t.new/build" "$t.new"/.[!.]* "$t.new"/..?*
  find "$t.new" -name '*.md' -prune -exec rm -rf {} +
  if [ "${pair##*:}" = vault ]; then install -m 644 "$D/static-config/$VC/vault-config.js" "$t.new/vault-config.js"; fi
  own "$t.new"; rm -rf "$t.old"; if [ -d "$t" ]; then mv "$t" "$t.old"; fi; mv "$t.new" "$t"; rm -rf "$t.old"
  echo "published $t"
done
install -d -m 755 "$R/var/www/rawprod-config/$CC"
install -m 644 "$D/static-config/$CC/console-config.js" "$R/var/www/rawprod-config/$CC/console-config.js"
echo "published $R/var/www/rawprod-config/$CC/console-config.js"
