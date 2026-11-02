import { describe, expect, it } from 'vitest';
import { CWS_API, publishToStore, StoreError, UPLOAD_IN_PROGRESS_STATES } from '../../../scripts/release/lib/cws.mjs';

const PUBLISHER = 'pub-0000000000';
const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'ya29.synthetic-access-token-never-logged';
const VERSION = '1.2.3';
const ZIP = Buffer.from('PK\u0003\u0004synthetic-package-bytes');

const UPLOAD_URL = `${CWS_API}/upload/v2/publishers/${PUBLISHER}/items/${ITEM}:upload`;
const STATUS_URL = `${CWS_API}/v2/publishers/${PUBLISHER}/items/${ITEM}:fetchStatus`;
const PUBLISH_URL = `${CWS_API}/v2/publishers/${PUBLISHER}/items/${ITEM}:publish`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown; text?: string } | ((call: Call) => { status?: number; body?: unknown; text?: string });

/** Scripted fetch: replies are consumed in order; a function reply can inspect the call. */
function scriptedFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: Call = { url, method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {}, body: init?.body };
    calls.push(call);
    const reply = replies.shift();
    if (!reply) return Promise.reject(new Error(`unexpected request ${call.method} ${call.url}`));
    const resolved = typeof reply === 'function' ? reply(call) : reply;
    const text = resolved.text ?? (resolved.body === undefined ? '' : JSON.stringify(resolved.body));
    return Promise.resolve(new Response(text, { status: resolved.status ?? 200, headers: { 'Content-Type': 'application/json' } }));
  };
  return { fetch, calls, remaining: () => replies.length };
}

function harness(replies: Reply[], options: { timeoutMs?: number; pollIntervalMs?: number; maxStatusRetries?: number } = {}) {
  const net = scriptedFetch(replies);
  const logs: string[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const deps = {
    fetch: net.fetch,
    log: (line: string) => logs.push(line),
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxStatusRetries: options.maxStatusRetries ?? 3,
  };
  const run = (action: 'upload' | 'submit' | 'submit-staged' = 'upload', overrides: Partial<Parameters<typeof publishToStore>[0]> = {}) =>
    publishToStore({ publisher: PUBLISHER, item: ITEM, zip: ZIP, expectedVersion: VERSION, action, token: TOKEN, ...overrides }, deps);
  const failure = async (...args: Parameters<typeof run>): Promise<StoreError> => {
    try {
      await run(...args);
    } catch (error) {
      if (error instanceof StoreError) return error;
      throw error;
    }
    throw new Error('expected publishToStore to fail');
  };
  const nothingLeaked = () => {
    for (const line of logs) expect(line).not.toContain(TOKEN);
  };
  return { ...net, logs, sleeps, run, failure, nothingLeaked, deps };
}

const succeeded = { body: { name: `publishers/${PUBLISHER}/items/${ITEM}`, itemId: ITEM, crxVersion: VERSION, uploadState: 'SUCCEEDED' } };
const pendingReview = { body: { name: `publishers/${PUBLISHER}/items/${ITEM}`, itemId: ITEM, state: 'PENDING_REVIEW' } };

describe('publishToStore: successful paths', () => {
  it('uploads the package with the bearer token and content type, and stops after the upload for upload-only', async () => {
    const h = harness([succeeded]);
    const result = await h.run('upload');
    expect(result).toEqual({ uploadState: 'SUCCEEDED', crxVersion: VERSION, submitted: false, publishType: null, itemState: null, warnings: undefined });
    expect(h.calls).toHaveLength(1);
    const [upload] = h.calls;
    expect(upload!.url).toBe(UPLOAD_URL);
    expect(upload!.method).toBe('POST');
    expect(upload!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(upload!.headers['Content-Type']).toBe('application/zip');
    expect(upload!.body).toBe(ZIP);
    expect(h.calls.some((c) => c.url.endsWith(':publish'))).toBe(false);
    expect(h.logs).toEqual([
      expect.stringMatching(/^Uploading \d+ bytes to Chrome Web Store item/),
      `Upload succeeded: draft version ${VERSION}.`,
      expect.stringMatching(/^No submission requested\./),
    ]);
    h.nothingLeaked();
  });

  it('polls fetchStatus while the upload is in progress and succeeds once the store reports SUCCEEDED', async () => {
    const h = harness([
      { body: { itemId: ITEM, uploadState: 'IN_PROGRESS' } },
      { body: { itemId: ITEM, lastAsyncUploadState: 'IN_PROGRESS' } },
      { body: { itemId: ITEM, lastAsyncUploadState: 'SUCCEEDED', submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: VERSION }] } } },
    ]);
    const result = await h.run('upload');
    expect(result.uploadState).toBe('SUCCEEDED');
    expect(result.crxVersion).toBeUndefined();
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${UPLOAD_URL}`, `GET ${STATUS_URL}`, `GET ${STATUS_URL}`]);
    expect(h.sleeps).toEqual([1_000, 1_000]);
    expect(h.calls[1]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.logs[1]).toBe(`Upload succeeded: draft version ${VERSION}.`);
  });

  it('accepts the UPLOAD_IN_PROGRESS spelling used in the API prose', async () => {
    expect([...UPLOAD_IN_PROGRESS_STATES]).toEqual(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
    const h = harness([{ body: { uploadState: 'UPLOAD_IN_PROGRESS' } }, { body: { lastAsyncUploadState: 'SUCCEEDED' } }]);
    await expect(h.run('upload')).resolves.toMatchObject({ uploadState: 'SUCCEEDED' });
  });

  it('submit-for-review uploads then publishes with DEFAULT_PUBLISH and reports the item state', async () => {
    const h = harness([succeeded, pendingReview]);
    const result = await h.run('submit');
    expect(result).toMatchObject({ submitted: true, publishType: 'DEFAULT_PUBLISH', itemState: 'PENDING_REVIEW' });
    const publish = h.calls[1]!;
    expect(publish.url).toBe(PUBLISH_URL);
    expect(publish.method).toBe('POST');
    expect(publish.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(publish.body as string)).toEqual({ publishType: 'DEFAULT_PUBLISH' });
    expect(h.logs).toContain('Submitted for review with DEFAULT_PUBLISH. Item state: PENDING_REVIEW.');
    expect(h.logs.at(-1)).toMatch(/published automatically\. Approval timing is outside this workflow/);
    expect(h.logs.join(' ')).not.toMatch(/now live|has been published|is now published/);
    h.nothingLeaked();
  });

  it('submit-staged publishes with STAGED_PUBLISH and says the release waits in the dashboard', async () => {
    const h = harness([succeeded, { body: { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'ICON', description: 'synthetic warning' }] } } }]);
    const result = await h.run('submit-staged');
    expect(result).toMatchObject({ submitted: true, publishType: 'STAGED_PUBLISH', itemState: 'PENDING_REVIEW' });
    expect(result.warnings).toEqual({ warnings: [{ reason: 'ICON', description: 'synthetic warning' }] });
    expect(JSON.parse(h.calls[1]!.body as string)).toEqual({ publishType: 'STAGED_PUBLISH' });
    expect(h.logs).toContain('Store warnings: {"warnings":[{"reason":"ICON","description":"synthetic warning"}]}');
    expect(h.logs.at(-1)).toMatch(/stays staged until it is published from the Developer Dashboard/);
  });

  it('upload-only never calls publish even when the store is slow', async () => {
    const h = harness([{ body: { uploadState: 'IN_PROGRESS' } }, { body: { lastAsyncUploadState: 'SUCCEEDED', crxVersion: VERSION } }]);
    await h.run('upload');
    expect(h.calls.filter((c) => c.url.endsWith(':publish'))).toHaveLength(0);
    expect(h.remaining()).toBe(0);
  });
});

describe('publishToStore: input validation happens before any network call', () => {
  it('rejects a malformed extension id', async () => {
    const h = harness([]);
    const error = await h.failure('upload', { item: 'not-an-id' });
    expect(error.stage).toBe('input');
    expect(error.message).toMatch(/not a Chrome Web Store extension id/);
    expect(h.calls).toHaveLength(0);
  });

  it('rejects a missing publisher, token, action or package', async () => {
    const h = harness([]);
    expect((await h.failure('upload', { publisher: '' })).message).toMatch(/missing publisher/);
    expect((await h.failure('upload', { token: '' })).message).toMatch(/CWS_ACCESS_TOKEN is not set/);
    expect((await h.failure('upload', { expectedVersion: '' })).message).toMatch(/missing publisher, item or expected version/);
    expect((await h.failure('nonsense' as 'upload')).message).toMatch(/unknown action "nonsense"; use upload, submit, submit-staged/);
    expect((await h.failure('upload', { zip: Buffer.alloc(0) })).message).toMatch(/package is empty/);
    expect(h.calls).toHaveLength(0);
  });
});

describe('publishToStore: store failures are actionable and never leak the token', () => {
  it('reports an upload the store rejected, with the item error', async () => {
    const h = harness([{ body: { uploadState: 'FAILED', itemError: [{ error_code: 'PKG_INVALID_VERSION_NUMBER', error_detail: 'synthetic detail' }] } }]);
    const error = await h.failure('upload');
    expect(error.stage).toBe('upload');
    expect(error.message).toMatch(/upload did not succeed \(state FAILED\)/);
    expect(error.message).toContain('PKG_INVALID_VERSION_NUMBER');
    expect(h.calls).toHaveLength(1);
    h.nothingLeaked();
  });

  it('explains an authentication failure (HTTP 401) without echoing the credential', async () => {
    const h = harness([{ status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } }]);
    const error = await h.failure('upload');
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/HTTP 401: Request had invalid authentication credentials\./);
    expect(error.message).toMatch(/access token was rejected.*Workload Identity Federation/);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('Authorization');
    h.nothingLeaked();
  });

  it('explains a permission failure (HTTP 403)', async () => {
    const h = harness([{ status: 403, body: { error: { message: 'The caller does not have permission' } } }]);
    const error = await h.failure('submit');
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/add the service account to the publisher.*enable the Chrome Web Store API/);
    expect(h.calls).toHaveLength(1);
  });

  it('points at the identifiers when the publisher or item is not found (HTTP 404)', async () => {
    const h = harness([{ status: 404, body: { error: { message: 'Requested entity was not found.' } } }]);
    const error = await h.failure('upload');
    expect(error.message).toMatch(/check CWS_PUBLISHER_ID and CWS_EXTENSION_ID/);
  });

  it('does not retry a rate-limited upload (HTTP 429) because uploads are not idempotent', async () => {
    const h = harness([{ status: 429, body: { error: { message: 'Quota exceeded' } } }]);
    const error = await h.failure('upload');
    expect(error.status).toBe(429);
    expect(error.message).toMatch(/rate-limited.*re-run the workflow/);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('retries transient fetchStatus failures (HTTP 429 and 5xx) with backoff and then continues', async () => {
    const h = harness([
      { body: { uploadState: 'IN_PROGRESS' } },
      { status: 429, body: { error: { message: 'Quota exceeded' } } },
      { status: 503, text: '<html>Service Unavailable</html>' },
      { body: { lastAsyncUploadState: 'SUCCEEDED', crxVersion: VERSION } },
    ]);
    await expect(h.run('upload')).resolves.toMatchObject({ uploadState: 'SUCCEEDED' });
    expect(h.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(h.sleeps).toEqual([1_000, 1_000, 2_000]);
  });

  it('gives up on fetchStatus after the retry budget', async () => {
    const h = harness([{ body: { uploadState: 'IN_PROGRESS' } }, { status: 500, text: 'boom' }, { status: 500, text: 'boom' }, { status: 502, text: 'boom' }], { maxStatusRetries: 2 });
    const error = await h.failure('upload');
    expect(error.stage).toBe('status');
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/HTTP 502: boom\. The store reported a server error/);
    expect(h.calls).toHaveLength(4);
  });

  it('reports a server error on upload (HTTP 500) with the raw body when it is not JSON', async () => {
    const h = harness([{ status: 500, text: 'Internal error occurred' }]);
    const error = await h.failure('upload');
    expect(error.message).toMatch(/POST \/upload\/v2\/publishers\/.*:upload failed with HTTP 500: Internal error occurred\. The store reported a server error/);
  });

  it('rejects unexpected response formats instead of guessing', async () => {
    expect((await harness([{ body: [1, 2, 3] }]).failure('upload')).message).toMatch(/unexpected response body/);
    expect((await harness([{ text: 'this is not json' }]).failure('upload')).message).toMatch(/unexpected response body/);
    const unknownState = await harness([{ body: { itemId: ITEM } }]).failure('upload');
    expect(unknownState.message).toMatch(/upload did not succeed \(state UNKNOWN\) \(the response did not include an upload state\)/);
    const notFound = await harness([{ body: { uploadState: 'IN_PROGRESS' } }, { body: { lastAsyncUploadState: 'NOT_FOUND' } }]).failure('upload');
    expect(notFound.message).toMatch(/state NOT_FOUND.*no record of the upload/);
  });

  it('times out an upload that never leaves the in-progress state and says how to recover', async () => {
    const forever = Array.from({ length: 50 }, () => ({ body: { lastAsyncUploadState: 'IN_PROGRESS' } }));
    const h = harness([{ body: { uploadState: 'IN_PROGRESS' } }, ...forever], { timeoutMs: 5_000, pollIntervalMs: 1_000 });
    const error = await h.failure('upload');
    expect(error.stage).toBe('status');
    expect(error.message).toMatch(/still in progress after 0 minutes.*Developer Dashboard before re-running/);
    expect(h.calls.filter((c) => c.method === 'GET')).toHaveLength(5);
    expect(h.calls.some((c) => c.url.endsWith(':publish'))).toBe(false);
  });

  it('refuses to continue when the store reports a different version than the release', async () => {
    const h = harness([{ body: { uploadState: 'SUCCEEDED', crxVersion: '9.9.9' } }]);
    const error = await h.failure('submit');
    expect(error.message).toBe('the store accepted version 9.9.9, expected 1.2.3; the uploaded package does not match the release');
    expect(h.calls).toHaveLength(1);
  });

  it('reports a submission that fails after a successful upload, keeping the upload result visible in the log', async () => {
    const h = harness([succeeded, { status: 400, body: { error: { message: 'Publish condition not met: listing incomplete' } } }]);
    const error = await h.failure('submit');
    expect(error.stage).toBe('publish');
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/POST \/v2\/publishers\/.*:publish failed with HTTP 400: Publish condition not met: listing incomplete/);
    expect(h.logs).toContain(`Upload succeeded: draft version ${VERSION}.`);
    expect(h.logs.some((l) => l.startsWith('Submitted'))).toBe(false);
    h.nothingLeaked();
  });

  it('wraps network failures so the token in the request never reaches the error', async () => {
    const h = harness([]);
    const failingFetch: typeof globalThis.fetch = () => Promise.reject(new Error('getaddrinfo ENOTFOUND chromewebstore.googleapis.com'));
    const deps = { ...h.deps, fetch: failingFetch };
    await expect(publishToStore({ publisher: PUBLISHER, item: ITEM, zip: ZIP, expectedVersion: VERSION, action: 'upload', token: TOKEN }, deps)).rejects.toMatchObject({
      name: 'StoreError',
      stage: 'upload',
      message: expect.stringMatching(/could not reach the Chrome Web Store: getaddrinfo ENOTFOUND/),
    });
  });
});
