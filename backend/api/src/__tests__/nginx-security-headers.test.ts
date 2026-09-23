/**
 * S3 security review items 6/7 — static self-checks over the checked-in nginx configs
 * (infra/aws/nginx/*.conf). Not a real nginx parse (no parser dependency for two small,
 * flat config files) — a location block here never nests another `{ }` pair, so
 * `location ... { ... }` matched non-greedily up to the first `}` reliably captures one
 * location's body, the same shape every location in these files already takes.
 *
 * Item 6: nginx's `add_header` is inherited from an outer block ONLY IF the current block
 * declares none of its own (documented in every security-headers-*.conf's own header comment)
 * — so a location that sets its own `add_header` (e.g. Cache-Control) but forgets the
 * `include .../security-headers-*.conf` line silently serves with NO security headers at all.
 * This asserts every such location in the TLS server blocks carries the include.
 *
 * Item 7: every TLS vhost must carry HSTS. Since every location in these files already sets
 * its own add_header (so inherits nothing from the server block), HSTS is added to the shared
 * security-headers-*.conf files themselves (already included everywhere) rather than only at
 * the server level — this asserts that placement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NGINX_DIR = join(__dirname, '../../../../infra/aws/nginx');

function read(name: string): string {
  return readFileSync(join(NGINX_DIR, name), 'utf8');
}

/** Every `location ... { ... }` block's full text, in file order. None of these files nest a
 *  second `{`/`}` pair inside a location body, so stopping at the first `}` is exact. */
function locationBlocks(conf: string): string[] {
  return conf.match(/location[^{]*\{[^}]*\}/g) ?? [];
}

const TLS_VHOST_FILES = ['rawprod-main.conf', 'vault.conf'];
const HEADER_INCLUDE_FILES = [
  'security-headers-factory.conf',
  'security-headers-platform.conf',
  'security-headers-vault.conf',
];

test('every location with its own add_header also includes a security-headers file', () => {
  for (const file of TLS_VHOST_FILES) {
    const conf = read(file);
    for (const block of locationBlocks(conf)) {
      if (!block.includes('add_header')) continue;
      assert.match(
        block,
        /include\s+\/etc\/nginx\/rawprod\/security-headers-\w+\.conf;/,
        `${file}: a location sets its own add_header but has no security-headers include:\n${block}`,
      );
    }
  }
});

test('every shared security-headers file carries HSTS with the required directives', () => {
  for (const file of HEADER_INCLUDE_FILES) {
    const conf = read(file);
    assert.match(
      conf,
      /add_header\s+Strict-Transport-Security\s+"max-age=31536000;\s*includeSubDomains"\s+always;/,
      `${file} is missing a correctly-configured HSTS header`,
    );
  }
});

test('every TLS server block (listen 443) includes at least one security-headers file directly', () => {
  for (const file of TLS_VHOST_FILES) {
    const conf = read(file);
    // Split into server{} blocks the same non-nesting way — every server block in these files
    // is flat except for its location sub-blocks, which themselves contain no further nesting.
    const serverBlocks = conf.match(/server\s*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
    const tlsBlocks = serverBlocks.filter((b) => /listen\s+443/.test(b));
    assert.ok(tlsBlocks.length > 0, `${file}: found no TLS (listen 443) server blocks to check`);
    for (const block of tlsBlocks) {
      assert.match(
        block,
        /include\s+\/etc\/nginx\/rawprod\/security-headers-\w+\.conf;/,
        `${file}: a TLS server block never includes a security-headers file at all:\n${block.slice(0, 200)}...`,
      );
    }
  }
});
