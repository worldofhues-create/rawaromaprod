/* Stands in for nginx and nothing else: the same static roots, the same proxied paths and the same
 * security headers as infra/aws/nginx (the CSP is read from the deployed conf, so a console that
 * would be blocked in production is blocked here). There is no fake API behind it. */
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { ROOT } from './config.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

function deployedHeaders(profile) {
  const text = readFileSync(join(ROOT, 'infra/aws/nginx', `security-headers-${profile}.conf`), 'utf8');
  const out = {};
  for (const m of text.matchAll(/^add_header\s+(\S+)\s+"([^"]*)"/gm)) {
    if (m[1] !== 'Strict-Transport-Security') out[m[1]] = m[2]; // http on loopback
  }
  return out;
}

function proxy(req, res, port, path, headers) {
  const up = request({ host: '127.0.0.1', port, path, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, { ...r.headers, ...headers });
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502, headers); res.end('upstream down'); });
  req.pipe(up);
}

/** `routes(pathname)` answers [apiPort, upstreamPath] when the path is proxied. */
export function serveConsole({ port, dir, profile, routes, configScript }) {
  const headers = deployedHeaders(profile);
  const root = join(ROOT, dir);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const hit = routes(url.pathname);
    if (hit) return proxy(req, res, hit[0], hit[1] + url.search, headers);
    if (configScript && url.pathname === configScript.path) {
      res.writeHead(200, { ...headers, 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      return res.end(configScript.body);
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (rel.split(sep).includes('..')) { res.writeHead(404, headers); return res.end(); }
    try {
      let body = await readFile(join(root, rel === '' ? 'index.html' : rel));
      // The deployed vhost's sub_filter: rawvault.conf puts the config script ahead of the bundle.
      if (configScript && (rel === '' || rel === 'index.html')) {
        body = body.toString('utf8').replace(configScript.before, `<script src="${configScript.path}"></script>${configScript.before}`);
      }
      res.writeHead(200, { ...headers, 'content-type': MIME[extname(rel || 'index.html')] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404, headers); res.end('not found'); }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
