import { PORTS } from './config.mjs';

export default async function globalSetup() {
  for (const [name, port] of [['main API', PORTS.api], ['Vault API', PORTS.vaultApi]] as const) {
    const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    if (!res?.ok) throw new Error(`${name} is not up on :${port}. Run pnpm e2e:up first; this suite never runs against a mock.`);
  }
}
