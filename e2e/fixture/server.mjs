/**
 * Deterministic local fixture for TokenLens end-to-end tests.
 *
 *  - /app/            synthetic single-page app that sends requests with synthetic Bearer tokens
 *  - /api/<status>    endpoints answering 200, 201, 401, 403, 500 (plus /api/slow)
 *  - everything else  static files from dist/ so the built panel can be opened as a plain page
 *
 * Nothing here is a real credential: tokens are generated client-side from a test clock and signed
 * with a fixed placeholder string.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const distDir = join(root, 'dist');
const port = Number(process.env.TOKENLENS_FIXTURE_PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

const API = {
  '/api/ok': { status: 200, body: { ok: true } },
  '/api/created': { status: 201, body: { created: true } },
  '/api/unauthorized': { status: 401, body: { error: 'invalid_token' } },
  '/api/forbidden': { status: 403, body: { error: 'insufficient_scope' } },
  '/api/error': { status: 500, body: { error: 'server_error' } },
  '/api/redirect': { status: 302, body: null, headers: { Location: '/api/ok' } },
};

export const APP_HTML = await readFile(new URL('./app.html', import.meta.url), 'utf8');

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function serveStatic(res, pathname) {
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(distDir, safePath);
  if (!filePath.startsWith(distDir)) return send(res, 403, 'forbidden');
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return send(res, 404, 'not found');
    const data = await readFile(filePath);
    return send(res, 200, data, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  } catch {
    return send(res, 404, `not found: ${pathname}`);
  }
}

export function createFixtureServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    if (pathname === '/app' || pathname === '/app/' || pathname === '/app/index.html') {
      return send(res, 200, APP_HTML, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/slow') {
        await new Promise((r) => setTimeout(r, Number(url.searchParams.get('ms') ?? 300)));
        return send(res, 200, JSON.stringify({ slow: true }), { 'Content-Type': 'application/json' });
      }
      const route = API[pathname];
      if (!route) return send(res, 404, JSON.stringify({ error: 'not_found' }), { 'Content-Type': 'application/json' });
      const echo = { ...route.body, authorizationPresent: typeof req.headers.authorization === 'string' };
      return send(res, route.status, route.body === null ? '' : JSON.stringify(echo), {
        'Content-Type': 'application/json',
        ...(route.headers ?? {}),
      });
    }

    return serveStatic(res, pathname === '/' ? '/src/devtools/panel/panel.html' : pathname);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createFixtureServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`TokenLens fixture listening on http://127.0.0.1:${port}  (app: /app/, panel: /)`);
  });
}
