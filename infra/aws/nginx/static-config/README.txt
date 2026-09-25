Per-deployment browser config for the static RawProd consoles, injected by nginx sub_filter ahead of
each console's bundle (recorded from live 2026-09-25, OPS_GREEN §17). Public by construction: every
file here is served to any browser, so nothing secret may ever be added.

  prod/console-config.js  -> /var/www/rawprod-config/prod/console-config.js   (huecycle-hosts.conf, rawprod-cf-origin.conf)
  demo/console-config.js  -> /var/www/rawprod-config/demo/console-config.js   (huecycle-hosts.conf, demo hosts)
  vault/vault-config.js   -> /var/www/rawprod-cf/vault/vault-config.js        (rawvault.conf; the file sits in the vault static root)

Install (root, app box): install -D -m 644 <file> <target>; then `nginx -t && systemctl reload nginx`.
A RawProd web deploy that refreshes /var/www/rawprod-cf/vault must re-install vault-config.js.
