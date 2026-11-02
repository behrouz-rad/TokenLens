import type { CaptureObservation } from '@/core/capture/observation';
import { createSyntheticJwt, withBearer } from '@/core/testing/synthetic';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Development-only seed used when the panel runs outside DevTools. Everything here is
 * synthetic: issuers, subjects and signatures are placeholders and cannot authenticate anywhere.
 */
export function createMockObservations(now: number = Date.now()): CaptureObservation[] {
  const seconds = (ms: number) => Math.floor(ms / 1000);

  const accessToken = createSyntheticJwt(
    { alg: 'RS256', typ: 'at+jwt', kid: 'synthetic-key-1' },
    {
      iss: 'https://issuer.example.test/',
      sub: 'user_12345',
      aud: 'api://example-api',
      exp: seconds(now + 2 * MINUTE + 14_000),
      iat: seconds(now - 5 * MINUTE),
      nbf: seconds(now - 5 * MINUTE),
      jti: '7f3c2a1e-9c4b-4e3d-b9a7-5e8f1d2c3b4a',
      scope: 'users.read users.write orders.create',
      roles: ['Admin'],
      tenant: { id: 'tenant_42', region: 'eu-west' },
      amr: ['pwd', 'mfa'],
    }
  );
  const idToken = createSyntheticJwt(
    { alg: 'RS256', typ: 'JWT', kid: 'synthetic-key-1' },
    {
      iss: 'https://issuer.example.test/',
      sub: 'user_12345',
      aud: 'client-app',
      exp: seconds(now + 59 * MINUTE),
      iat: seconds(now - MINUTE),
      nonce: 'n-0S6_WzA2Mj',
      at_hash: 'synthetic',
      name: 'Zoë Ürsula Ångström 🔐',
      email: 'zoe@example.test',
    }
  );
  const genericJwt = createSyntheticJwt(
    { alg: 'ES256', typ: 'JWT' },
    {
      iss: 'https://issuer.example.test/',
      sub: 'service_account_1',
      aud: ['api://tenant-service', 'api://billing'],
      exp: seconds(now + 4 * MINUTE),
      iat: seconds(now - 2 * MINUTE),
      permissions: { tenants: ['read', 'manage'], billing: ['read'] },
    }
  );
  const noExpiryJwt = createSyntheticJwt(
    { alg: 'HS256', typ: 'JWT' },
    { iss: 'https://legacy.example.test/', sub: 'batch_job', iat: seconds(now - HOUR) }
  );
  const expiredJwt = createSyntheticJwt(
    { alg: 'HS256', typ: 'JWT' },
    { iss: 'https://old.example.test/', sub: 'user_old', exp: seconds(now - 2 * HOUR), iat: seconds(now - 4 * HOUR), scope: 'read' }
  );
  const unsignedJwt = createSyntheticJwt({ alg: 'none' }, { sub: 'anonymous', exp: seconds(now + 10 * MINUTE) }, '');
  const malformedJwt = 'eyJhbGciOiJSUzI1NiJ9.this-is-not-json.sig';
  const opaqueToken = 'ya29.synthetic-opaque-token-value-0123456789';

  const at = (offsetMs: number) => now - offsetMs;
  const api = (path: string) => `https://api.example.test${path}`;

  return [
    withBearer(accessToken, { url: api('/api/users'), startedAt: at(90_000), durationMs: 120 }),
    withBearer(accessToken, { url: api('/api/tenants/42/settings'), startedAt: at(80_000), durationMs: 98 }),
    withBearer(accessToken, { url: api('/api/orders'), method: 'POST', status: 201, statusText: 'Created', startedAt: at(70_000), durationMs: 210 }),
    withBearer(accessToken, { url: api('/api/admin/audit'), status: 403, statusText: 'Forbidden', startedAt: at(60_000), durationMs: 35 }),
    withBearer(accessToken, { url: api('/api/reports'), status: 500, statusText: 'Internal Server Error', startedAt: at(50_000), durationMs: 1_240 }),
    withBearer(idToken, { url: 'https://issuer.example.test/userinfo', startedAt: at(45_000), durationMs: 64 }),
    withBearer(genericJwt, { url: api('/api/tenants'), startedAt: at(40_000), durationMs: 88 }),
    withBearer(genericJwt, { url: api('/api/billing/invoices'), method: 'PUT', startedAt: at(30_000), durationMs: 143 }),
    withBearer(noExpiryJwt, { url: 'https://legacy.example.test/jobs', startedAt: at(25_000) }),
    withBearer(expiredJwt, { url: 'https://old.example.test/api/profile', status: 401, statusText: 'Unauthorized', startedAt: at(20_000), durationMs: 22 }),
    withBearer(unsignedJwt, { url: api('/api/public/feed'), startedAt: at(15_000) }),
    withBearer(malformedJwt, { url: api('/api/health'), status: 401, statusText: 'Unauthorized', startedAt: at(10_000) }),
    withBearer(opaqueToken, { url: 'https://www.googleapis.example.test/oauth2/v3/tokeninfo', startedAt: at(5_000) }),
  ];
}
