/**
 * L1 (security review) — the listen host for vault-main.ts.
 *
 * The app box calls the Vault's /internal port ACROSS hosts (VAULT_API_INTERNAL_URL), so binding
 * 127.0.0.1 would break the channel. Set VAULT_BIND_HOST to the Vault EC2's private-interface IP
 * to bind only that interface; unset keeps the historical 0.0.0.0. In either case the security
 * group (inbound on this port from the app-box SG ONLY — scripts/apply-vault-port-sg-rule.sh)
 * is the sole network path to this port; InternalBridgeGuard is the application-level control.
 */
export const DEFAULT_VAULT_BIND_HOST = '0.0.0.0';

export function resolveVaultBindHost(configured: string | undefined | null): string {
  const v = (configured ?? '').trim();
  return v.length > 0 ? v : DEFAULT_VAULT_BIND_HOST;
}
