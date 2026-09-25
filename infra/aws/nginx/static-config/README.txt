Per-deployment browser config for the static RawProd consoles, injected by nginx sub_filter ahead of
each console's bundle (recorded from live 2026-09-25, OPS_GREEN §17; demo-vault added by lane cfg-rp).
Public by construction: every file here is served to any browser, so nothing secret may ever be added.

  prod/console-config.js     -> /var/www/rawprod-config/prod/console-config.js      (huecycle-hosts.conf, rawprod-cf-origin.conf)
  demo/console-config.js     -> /var/www/rawprod-config/demo/console-config.js      (huecycle-hosts.conf demo hosts, demo/nginx/rawaroma-demo-origin.conf)
  vault/vault-config.js      -> /var/www/rawprod-cf/vault/vault-config.js           (rawvault.conf; the file sits in the vault static root)
  demo-vault/vault-config.js -> /var/www/rawprod-demo-cf/vault/vault-config.js      (rawdemovault.conf; same, in the DEMO vault root)

Install (root, app box): infra/aws/nginx/install-static.sh prod|demo — refreshes the three static roots
(/var/www/rawprod-cf/{factory,platform,vault} or /var/www/rawprod-demo-cf/{factory,platform,vault}) from the
checkout's web, web-platform and web-vault trees and installs these files; no nginx reload is needed.
A RawProd web deploy that refreshes a vault root must re-run it: vault-config.js lives inside that root.
