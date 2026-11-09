import { act, cleanup, render, type RenderResult } from '@testing-library/react';
import { Toaster } from 'sonner';
import type { ReactElement } from 'react';
import { resetCaptureStoreForTests, useCaptureStore } from '@/state/capture-store';
import { resetUIStoreForTests } from '@/state/ui-store';
import { resetDecoderStoreForTests } from '@/state/decoder-store';
import { createSyntheticJwt, resetSyntheticSequence, withBearer } from '@/core/testing/synthetic';
import type { CaptureObservation } from '@/core/capture/observation';

export const NOW = 1_700_000_000_000;
export const seconds = (ms: number) => Math.floor(ms / 1000);

/**
 * Unmounts first: Vitest runs a test file's afterEach before the setup file's RTL cleanup, so
 * resetting the stores while components are still mounted would re-render them outside act().
 */
export function resetStores(): void {
  cleanup();
  resetSyntheticSequence();
  resetCaptureStoreForTests();
  resetUIStoreForTests();
  resetDecoderStoreForTests();
  try {
    localStorage.clear();
  } catch {
    // jsdom always provides localStorage; guard anyway for parity with the app code.
  }
  document.documentElement.className = '';
}

/** Store updates from outside React are wrapped in act() so assertions see the re-rendered DOM. */
export function seed(observations: CaptureObservation[], context = { recording: true, clearOnNavigation: false }): void {
  act(() => {
    useCaptureStore.getState().ingest(observations, context);
  });
}

export function renderWithStores(ui: ReactElement): RenderResult {
  return render(
    <>
      <Toaster />
      {ui}
    </>
  );
}

export const FIXTURE = {
  access: createSyntheticJwt(
    { alg: 'RS256', typ: 'at+jwt', kid: 'kid-1' },
    { iss: 'https://issuer.example.test', sub: 'user-1', aud: 'api://demo', exp: seconds(NOW) + 3600, iat: seconds(NOW) - 60, scope: 'read write', org: { id: 'o-1', tags: ['a', 'b'] } }
  ),
  expiring: createSyntheticJwt({ alg: 'HS256' }, { sub: 'user-2', exp: seconds(NOW) + 60 }),
  expired: createSyntheticJwt({ alg: 'HS256' }, { sub: 'user-3', iss: 'https://old.example.test', exp: seconds(NOW) - 3600 }),
  noExpiry: createSyntheticJwt({ alg: 'HS256' }, { sub: 'batch' }),
  unicode: createSyntheticJwt({ alg: 'ES256' }, { sub: 'ünïcødé', name: 'Zoë 🔐', exp: seconds(NOW) + 3600 }),
  opaque: 'opaque-synthetic-token-0001',
  malformed: 'eyJhbGciOiJSUzI1NiJ9.!!!.sig',
};

export function standardScenario(): CaptureObservation[] {
  return [
    withBearer(FIXTURE.access, { url: 'https://api.example.test/users', startedAt: NOW - 50_000 }),
    withBearer(FIXTURE.access, { url: 'https://api.example.test/orders', method: 'POST', status: 201, statusText: 'Created', startedAt: NOW - 40_000 }),
    withBearer(FIXTURE.access, { url: 'https://api.example.test/admin', status: 403, statusText: 'Forbidden', startedAt: NOW - 30_000 }),
    withBearer(FIXTURE.expiring, { url: 'https://api.example.test/soon', startedAt: NOW - 25_000 }),
    withBearer(FIXTURE.expired, { url: 'https://old.example.test/profile', status: 401, statusText: 'Unauthorized', startedAt: NOW - 20_000 }),
    withBearer(FIXTURE.noExpiry, { url: 'https://legacy.example.test/jobs', startedAt: NOW - 15_000 }),
    withBearer(FIXTURE.opaque, { url: 'https://oauth.example.test/userinfo', startedAt: NOW - 10_000 }),
    withBearer(FIXTURE.malformed, { url: 'https://api.example.test/broken', status: 500, statusText: 'Internal Server Error', startedAt: NOW - 5_000 }),
  ];
}
