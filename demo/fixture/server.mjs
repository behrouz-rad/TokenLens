/**
 * Synthetic backend for the TokenLens promotional video.
 *
 * One local server answers for every `*.example.test` host (Chromium maps them here with
 * --host-resolver-rules, see demo/record.spec.ts). The Host header picks the virtual service:
 *
 *   app.example.test       the "Acme Console" page that sends the requests (demo/fixture/app.html)
 *   api.example.test       orders, profile and session API
 *   billing.example.test   invoices API (rejects the expired token the story is about)
 *   search.example.test    suggestion API that takes an opaque Bearer value
 *
 * `.test` is reserved (RFC 2606), so none of these names can reach a real system. Every token is
 * generated in the page from a placeholder signature and authenticates nothing; the server never
 * inspects the Authorization value beyond the scripted outcome of each route.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.TOKENLENS_DEMO_PORT ?? 4180);
const APP_HTML = await readFile(new URL('./app.html', import.meta.url), 'utf8');

/** Scripted outcomes; `ms` gives the Duration column believable, deterministic values. */
const ROUTES = {
  'api.example.test': {
    'GET /v1/me': { status: 200, ms: 14, body: { id: 'user_7Hq2', plan: 'team' } },
    'GET /v1/session': { status: 200, ms: 9, body: { active: true } },
    'GET /v1/orders': { status: 200, ms: 38, body: { items: 3 } },
    'POST /v1/orders': { status: 201, ms: 52, body: { id: 1043 } },
    'GET /v1/orders/1042': { status: 200, ms: 16, body: { id: 1042 } },
    'DELETE /v1/orders/1042': { status: 403, ms: 11, body: { error: 'insufficient_scope', required: 'orders:delete' } },
    'GET /v1/notifications': { status: 200, ms: 19, body: { unread: 2 } },
    'GET /v1/reports/weekly': { status: 500, ms: 140, body: { error: 'upstream_timeout' } },
  },
  'billing.example.test': {
    'GET /v1/invoices': { status: 401, ms: 10, body: { error: 'invalid_token', error_description: 'The access token expired' } },
  },
  'search.example.test': {
    'GET /v1/suggest': { status: 200, ms: 22, body: { suggestions: ['order 1042'] } },
  },
};

const CORS = {
  'Access-Control-Allow-Origin': 'http://app.example.test',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function createDemoServer() {
  return createServer(async (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    if (host === 'app.example.test' || host === '127.0.0.1' || host === 'localhost') {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(res, 200, APP_HTML, { 'Content-Type': 'text/html; charset=utf-8' });
      }
      return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
    }

    const service = ROUTES[host];
    if (!service) return send(res, 404, 'unknown host', { 'Content-Type': 'text/plain' });
    if (req.method === 'OPTIONS') return send(res, 204, '', CORS);

    const route = service[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, JSON.stringify({ error: 'not_found' }), { 'Content-Type': 'application/json', ...CORS });
    await new Promise((r) => setTimeout(r, route.ms));
    return send(res, route.status, JSON.stringify(route.body), { 'Content-Type': 'application/json', ...CORS });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createDemoServer().listen(port, '127.0.0.1', () => {
    console.log(`TokenLens demo backend on http://127.0.0.1:${port} (hosts: app|api|billing|search.example.test)`);
  });
}
