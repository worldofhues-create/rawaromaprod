/* The three console origins, as one long-lived process of the stack. */
import { PORTS } from './config.mjs';
import { serveConsole } from './console-server.mjs';

const main = (p) => {
  if (p === '/rpc' || p === '/health' || p.startsWith('/crypto/') || p.startsWith('/v1/') || p.startsWith('/auth/')) return [PORTS.api, p];
  return null;
};
serveConsole({ port: PORTS.factory, dir: 'web', profile: 'factory', routes: main });
serveConsole({ port: PORTS.platform, dir: 'web-platform', profile: 'platform', routes: main });
// rawvault.conf: its own API, plus exactly two paths to the main API under /main/.
serveConsole({
  port: PORTS.vault, dir: 'web-vault', profile: 'vault',
  configScript: { path: '/vault-config.js', before: '<script src="/vault.js"></script>', body: "window.MAIN_API = '/main';\n" },
  routes: (p) => {
    if (p === '/main/crypto/handshake') return [PORTS.api, '/crypto/handshake'];
    if (p === '/main/rpc') return [PORTS.api, '/rpc'];
    if (p.startsWith('/main/')) return null;
    if (p === '/rpc' || p === '/health' || p.startsWith('/crypto/') || p.startsWith('/v1/') || p.startsWith('/auth/')) return [PORTS.vaultApi, p];
    return null;
  },
});
