import { describe, expect, it } from 'vitest';
import {
  CWS_API,
  createStoreClient,
  describeOutcome,
  publishTypeFor,
  reconcileStoreStatus,
  recoverStoreRelease,
  storeActionFromInput,
  StoreError,
} from '../../../scripts/release/lib/cws.mjs';

const PUBLISHER = 'pub-0000000000';
const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'ya29.synthetic-access-token-never-logged';
const VERSION = '1.2.3';
const ZIP = Buffer.from('PK\u0003\u0004synthetic-package-bytes');
const NAME = `publishers/${PUBLISHER}/items/${ITEM}`;

const UPLOAD_URL = `${CWS_API}/upload/v2/${NAME}:upload`;
const STATUS_URL = `${CWS_API}/v2/${NAME}:fetchStatus`;
const PUBLISH_URL = `${CWS_API}/v2/${NAME}:publish`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
interface ReplyValue { status?: number; body?: unknown; text?: string }
type Reply = ReplyValue | ((call: Call) => ReplyValue);

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

type Action = 'upload' | 'submit' | 'submit-staged';
type Options = Parameters<typeof recoverStoreRelease>[0];

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
  const run = (action: Action = 'submit', overrides: Partial<Options> = {}) =>
    recoverStoreRelease({ publisher: PUBLISHER, item: ITEM, zip: ZIP, expectedVersion: VERSION, action, token: TOKEN, replaceDraft: true, ...overrides }, deps);
  const failure = async (...args: Parameters<typeof run>): Promise<StoreError> => {
    try {
      await run(...args);
    } catch (error) {
      if (error instanceof StoreError) return error;
      throw error;
    }
    throw new Error('expected recoverStoreRelease to fail');
  };
  const methods = () => net.calls.map((c) => `${c.method} ${c.url.replace(CWS_API, '')}`);
  const mutations = () => net.calls.filter((c) => c.method === 'POST');
  const nothingLeaked = (error?: Error) => {
    for (const line of logs) expect(line).not.toContain(TOKEN);
    if (error) {
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).not.toContain('Authorization');
    }
  };
  return { ...net, logs, sleeps, deps, run, failure, methods, mutations, nothingLeaked };
}

/** fetchStatus responses as the API documents them. */
const revision = (state: string, ...versions: string[]) => ({ state, distributionChannels: versions.map((crxVersion) => ({ crxVersion, deployPercentage: 100 })) });
const status = (fields: Record<string, unknown> = {}) => ({ body: { name: NAME, itemId: ITEM, ...fields } });
const uploaded = { body: { name: NAME, itemId: ITEM, crxVersion: VERSION, uploadState: 'SUCCEEDED' } };
const pendingReview = { body: { name: NAME, itemId: ITEM, state: 'PENDING_REVIEW' } };

/**
 * A stateful fake store for scenarios that run the recovery more than once: uploads replace the
 * draft and record the last upload state, publish moves the draft into the submitted revision.
 */
function fakeStore(initial: { published?: string; submitted?: { state: string; version: string } } = {}) {
  const state = { published: initial.published ?? null, submitted: initial.submitted ?? null, lastUpload: null as string | null, draft: null as string | null, uploads: 0, publishes: 0 };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (init?.headers && (init.headers as Record<string, string>).Authorization !== `Bearer ${TOKEN}`) return json({ error: { message: 'bad token' } });
    if (url === STATUS_URL) {
      return json({
        name: NAME,
        itemId: ITEM,
        ...(state.published ? { publishedItemRevisionStatus: revision('PUBLISHED', state.published) } : {}),
        ...(state.submitted ? { submittedItemRevisionStatus: revision(state.submitted.state, state.submitted.version) } : {}),
        ...(state.lastUpload ? { lastAsyncUploadState: state.lastUpload } : {}),
      });
    }
    if (url === UPLOAD_URL) {
      state.uploads += 1;
      state.lastUpload = 'SUCCEEDED';
      state.draft = VERSION;
      return json({ name: NAME, itemId: ITEM, crxVersion: VERSION, uploadState: 'SUCCEEDED' });
    }
    if (url === PUBLISH_URL) {
      state.publishes += 1;
      state.submitted = { state: 'PENDING_REVIEW', version: state.draft ?? 'unknown' };
      return json({ name: NAME, itemId: ITEM, state: 'PENDING_REVIEW' });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  };
  return { state, fetch };
}

describe('reconcileStoreStatus: decides without touching the store', () => {
  const decide = (fields: Record<string, unknown>) => reconcileStoreStatus({ name: NAME, itemId: ITEM, ...fields }, { version: VERSION });

  it('needs an upload when the store has no record of the version', () => {
    const empty = decide({});
    expect(empty.decision).toBe('upload-needed');
    expect(empty.detail).toMatch(/no upload was recorded in the last 24 hours/);
    expect(empty.detail).toMatch(/does not expose an unsubmitted draft's version or content/);
    expect(decide({ lastAsyncUploadState: 'FAILED' }).detail).toMatch(/last upload failed/);
    expect(decide({ lastAsyncUploadState: 'NOT_FOUND' }).detail).toMatch(/no record of a recent upload/);
    expect(decide({ lastAsyncUploadState: 'SUCCEEDED' }).detail).toMatch(/upload succeeded within the last 24 hours but was not submitted/);
  });

  it('waits while an earlier upload is processing, in either spelling', () => {
    expect(decide({ lastAsyncUploadState: 'IN_PROGRESS' }).decision).toBe('upload-in-progress');
    expect(decide({ lastAsyncUploadState: 'UPLOAD_IN_PROGRESS' }).decision).toBe('upload-in-progress');
  });

  it('leaves a version alone that is published, pending review or staged', () => {
    expect(decide({ publishedItemRevisionStatus: revision('PUBLISHED', VERSION) })).toMatchObject({ decision: 'already-published', published: { state: 'PUBLISHED', versions: [VERSION] } });
    expect(decide({ publishedItemRevisionStatus: revision('PUBLISHED_TO_TESTERS', VERSION) }).decision).toBe('already-published');
    expect(decide({ submittedItemRevisionStatus: revision('PENDING_REVIEW', VERSION) })).toMatchObject({ decision: 'in-review', submitted: { state: 'PENDING_REVIEW', versions: [VERSION] } });
    expect(decide({ submittedItemRevisionStatus: revision('STAGED', VERSION) }).decision).toBe('staged');
    expect(decide({ submittedItemRevisionStatus: revision('PUBLISHED', VERSION) }).decision).toBe('already-published');
    expect(decide({ publishedItemRevisionStatus: revision('PUBLISHED', '1.0.0'), submittedItemRevisionStatus: revision('PENDING_REVIEW', VERSION) }).decision).toBe('in-review');
  });

  it('treats another version in flight, a higher published version or an unreadable submission as a conflict', () => {
    const other = decide({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '1.2.4') });
    expect(other.decision).toBe('conflict');
    expect(other.detail).toMatch(/version 1\.2\.4 is already submitted \(state PENDING_REVIEW\); wait for its review to finish or cancel it/);
    const higher = decide({ publishedItemRevisionStatus: revision('PUBLISHED', '2.0.0') });
    expect(higher.decision).toBe('conflict');
    expect(higher.detail).toMatch(/already publishes version 2\.0\.0, which is higher than 1\.2\.3/);
    expect(decide({ submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }).decision).toBe('conflict');
    expect(decide({ submittedItemRevisionStatus: revision('SOMETHING_NEW', VERSION) }).decision).toBe('conflict');
    expect(decide({ publishedItemRevisionStatus: revision('PUBLISHED', '1.0.0') }).decision).toBe('upload-needed');
  });

  it('blocks on a taken-down item or a rejected submission, and proceeds after a cancelled one', () => {
    expect(decide({ takenDown: true, publishedItemRevisionStatus: revision('PUBLISHED', VERSION) })).toMatchObject({ decision: 'blocked', detail: expect.stringMatching(/taken down for a policy violation/) });
    expect(decide({ submittedItemRevisionStatus: revision('REJECTED', VERSION) })).toMatchObject({ decision: 'blocked', detail: expect.stringMatching(/was rejected; read the review message/) });
    expect(decide({ submittedItemRevisionStatus: revision('CANCELLED', VERSION) }).decision).toBe('upload-needed');
  });
});

describe('recoverStoreRelease: successful recoveries', () => {
  it('uploads and submits when the store has never seen the version (initial upload)', async () => {
    const h = harness([status(), uploaded, pendingReview]);
    const result = await h.run('submit');
    expect(result).toMatchObject({ outcome: 'submitted', mutated: true, publishType: 'DEFAULT_PUBLISH', itemState: 'PENDING_REVIEW' });
    expect(result.reconciliation.decision).toBe('upload-needed');
    expect(h.methods()).toEqual([`GET /v2/${NAME}:fetchStatus`, `POST /upload/v2/${NAME}:upload`, `POST /v2/${NAME}:publish`]);
    expect(h.calls[1]!.body).toBe(ZIP);
    expect(h.calls[1]!.headers['Content-Type']).toBe('application/zip');
    expect(JSON.parse(h.calls[2]!.body as string)).toEqual({ publishType: 'DEFAULT_PUBLISH' });
    expect(h.logs[0]).toMatch(/Checking the current state/);
    expect(h.logs.join(' ')).not.toMatch(/now live|has been published|is now published|approved/);
    h.nothingLeaked();
  });

  it('upload-only stops after the upload and never calls publish', async () => {
    const h = harness([status(), uploaded]);
    const result = await h.run('upload');
    expect(result).toMatchObject({ outcome: 'uploaded', mutated: true, publishType: null, itemState: null });
    expect(h.mutations().map((c) => c.url)).toEqual([UPLOAD_URL]);
    expect(h.logs.at(-1)).toMatch(/No submission requested/);
  });

  it('retries after a failed upload by uploading the verified package again', async () => {
    const h = harness([status({ lastAsyncUploadState: 'FAILED' }), uploaded, pendingReview]);
    const result = await h.run('submit');
    expect(result.outcome).toBe('submitted');
    expect(result.reconciliation.detail).toMatch(/last upload failed/);
    expect(h.mutations().map((c) => c.url)).toEqual([UPLOAD_URL, PUBLISH_URL]);
  });

  it('retries after a failed submission by re-uploading, because a draft cannot be proven to be the release package', async () => {
    const h = harness([status({ lastAsyncUploadState: 'SUCCEEDED' }), uploaded, pendingReview]);
    const result = await h.run('submit');
    expect(result.outcome).toBe('submitted');
    expect(result.reconciliation.detail).toMatch(/upload succeeded within the last 24 hours but was not submitted.*replaces whatever draft exists/);
    expect(h.mutations().map((c) => c.url)).toEqual([UPLOAD_URL, PUBLISH_URL]);
  });

  it('submit-staged publishes with STAGED_PUBLISH', async () => {
    const h = harness([status(), uploaded, { body: { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'ICON', description: 'synthetic' }] } } }]);
    const result = await h.run('submit-staged');
    expect(result).toMatchObject({ outcome: 'submitted', publishType: 'STAGED_PUBLISH', itemState: 'PENDING_REVIEW' });
    expect(JSON.parse(h.calls[2]!.body as string)).toEqual({ publishType: 'STAGED_PUBLISH' });
    expect(result.warnings).toEqual({ warnings: [{ reason: 'ICON', description: 'synthetic' }] });
  });

  it('waits for an earlier upload that is still processing, then recovers', async () => {
    const h = harness([status({ lastAsyncUploadState: 'IN_PROGRESS' }), status({ lastAsyncUploadState: 'UPLOAD_IN_PROGRESS' }), status({ lastAsyncUploadState: 'SUCCEEDED' }), uploaded, pendingReview]);
    const result = await h.run('submit');
    expect(result.outcome).toBe('submitted');
    expect(h.sleeps).toEqual([1_000, 1_000]);
    expect(h.methods().filter((m) => m.startsWith('GET'))).toHaveLength(3);
    expect(h.logs.filter((l) => l.includes('still being processed'))).toHaveLength(2);
  });

  it('polls through an in-progress upload of its own', async () => {
    const h = harness([status(), { body: { uploadState: 'IN_PROGRESS' } }, status({ lastAsyncUploadState: 'IN_PROGRESS' }), status({ lastAsyncUploadState: 'SUCCEEDED' }), pendingReview]);
    const result = await h.run('submit');
    expect(result.outcome).toBe('submitted');
    expect(h.methods()).toEqual([`GET /v2/${NAME}:fetchStatus`, `POST /upload/v2/${NAME}:upload`, `GET /v2/${NAME}:fetchStatus`, `GET /v2/${NAME}:fetchStatus`, `POST /v2/${NAME}:publish`]);
  });

  it('proceeds after a cancelled submission of the same version', async () => {
    const h = harness([status({ submittedItemRevisionStatus: revision('CANCELLED', VERSION) }), uploaded, pendingReview]);
    await expect(h.run('submit')).resolves.toMatchObject({ outcome: 'submitted' });
  });
});

describe('recoverStoreRelease: states that must not be mutated', () => {
  it('reports a version that is already pending review without submitting again', async () => {
    const h = harness([status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', VERSION) })]);
    const result = await h.run('submit');
    expect(result).toMatchObject({ outcome: 'in-review', mutated: false, itemState: 'PENDING_REVIEW' });
    expect(h.mutations()).toHaveLength(0);
    expect(h.logs.at(-1)).toMatch(/already submitted and pending review; no second submission/);
  });

  it('reports a staged version without publishing it', async () => {
    const h = harness([status({ submittedItemRevisionStatus: revision('STAGED', VERSION) })]);
    const result = await h.run('submit');
    expect(result).toMatchObject({ outcome: 'staged', mutated: false });
    expect(h.mutations()).toHaveLength(0);
  });

  it('exits successfully when the version is already published', async () => {
    const h = harness([status({ publishedItemRevisionStatus: revision('PUBLISHED', VERSION) })]);
    const result = await h.run('submit');
    expect(result).toMatchObject({ outcome: 'published', mutated: false });
    expect(h.mutations()).toHaveLength(0);
    expect(h.remaining()).toBe(0);
  });

  it('does not need the draft acknowledgement when nothing has to be uploaded', async () => {
    const h = harness([status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', VERSION) })]);
    await expect(h.run('submit', { replaceDraft: false })).resolves.toMatchObject({ outcome: 'in-review' });
  });
});

describe('recoverStoreRelease: safe failures', () => {
  it('refuses to upload without the explicit draft acknowledgement', async () => {
    const h = harness([status({ lastAsyncUploadState: 'SUCCEEDED' })]);
    const error = await h.failure('submit', { replaceDraft: false });
    expect(error.stage).toBe('reconcile');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/Re-run with replace_draft enabled.*Nothing was uploaded or submitted/);
    expect(h.mutations()).toHaveLength(0);
    h.nothingLeaked(error);
  });

  it('fails on a conflicting submitted version with instructions and no mutation', async () => {
    const h = harness([status({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '1.2.4') })]);
    const error = await h.failure('submit');
    expect(error.stage).toBe('reconcile');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/version 1\.2\.4 is already submitted.*cancel it in the Developer Dashboard before retrying 1\.2\.3\. Nothing was uploaded or submitted\./);
    expect(h.mutations()).toHaveLength(0);
  });

  it('fails when the store already publishes a higher version', async () => {
    const h = harness([status({ publishedItemRevisionStatus: revision('PUBLISHED', '2.0.0') })]);
    const error = await h.failure('submit');
    expect(error.message).toMatch(/already publishes version 2\.0\.0/);
    expect(h.mutations()).toHaveLength(0);
  });

  it('fails on a taken-down item and on a rejected submission (manual intervention)', async () => {
    expect((await harness([status({ takenDown: true })]).failure('submit')).message).toMatch(/taken down.*Nothing was uploaded or submitted/);
    const rejected = await harness([status({ submittedItemRevisionStatus: revision('REJECTED', VERSION) })]).failure('submit');
    expect(rejected.message).toMatch(/was rejected/);
    expect(rejected.retryable).toBe(false);
  });

  it('fails on an ambiguous submitted revision instead of guessing', async () => {
    const h = harness([status({ submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } })]);
    const error = await h.failure('submit');
    expect(error.message).toMatch(/submitted revision without a version/);
    expect(h.mutations()).toHaveLength(0);
  });

  it('times out while an earlier upload never finishes and says re-running is possible', async () => {
    const forever = Array.from({ length: 20 }, () => status({ lastAsyncUploadState: 'IN_PROGRESS' }));
    const h = harness(forever, { timeoutMs: 3_000, pollIntervalMs: 1_000 });
    const error = await h.failure('submit');
    expect(error.stage).toBe('status');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/still being processed after 0 minutes; re-run the retry later/);
    expect(h.mutations()).toHaveLength(0);
  });

  it('reports a failed upload state as not retryable', async () => {
    const h = harness([status(), { body: { uploadState: 'FAILED', itemError: [{ error_code: 'PKG_INVALID_VERSION_NUMBER', error_detail: 'synthetic' }] } }]);
    const error = await h.failure('submit');
    expect(error.stage).toBe('upload');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('PKG_INVALID_VERSION_NUMBER');
    expect(h.calls.some((c) => c.url === PUBLISH_URL)).toBe(false);
  });

  it('refuses a store that accepted a different version than the release', async () => {
    const h = harness([status(), { body: { uploadState: 'SUCCEEDED', crxVersion: '9.9.9' } }]);
    const error = await h.failure('submit');
    expect(error.message).toMatch(/accepted version 9\.9\.9, expected 1\.2\.3/);
    expect(h.calls.some((c) => c.url === PUBLISH_URL)).toBe(false);
  });

  it('maps authentication and authorisation failures to non-retryable errors without leaking the token', async () => {
    for (const [code, pattern] of [
      [401, /access token was rejected/],
      [403, /not allowed to manage this item/],
      [404, /check CWS_PUBLISHER_ID and CWS_EXTENSION_ID/],
    ] as const) {
      const h = harness([{ status: code, body: { error: { message: 'synthetic' } } }]);
      const error = await h.failure('submit');
      expect(error.status).toBe(code);
      expect(error.retryable).toBe(false);
      expect(error.message).toMatch(pattern);
      expect(h.calls).toHaveLength(1);
      h.nothingLeaked(error);
    }
  });

  it('retries rate limits and server errors on fetchStatus with backoff, then reports them as retryable', async () => {
    const recovered = harness([{ status: 429, body: { error: { message: 'Quota exceeded' } } }, { status: 503, text: 'unavailable' }, status(), uploaded, pendingReview]);
    await expect(recovered.run('submit')).resolves.toMatchObject({ outcome: 'submitted' });
    expect(recovered.sleeps).toEqual([1_000, 2_000]);

    const exhausted = harness([{ status: 500, text: 'boom' }, { status: 502, text: 'boom' }, { status: 503, text: 'boom' }, { status: 504, text: 'boom' }], { maxStatusRetries: 3 });
    const error = await exhausted.failure('submit');
    expect(error.status).toBe(504);
    expect(error.retryable).toBe(true);
    expect(exhausted.mutations()).toHaveLength(0);
  });

  it('does not retry a rate-limited upload or publish, but marks them retryable for a later run', async () => {
    const upload = harness([status(), { status: 429, body: { error: { message: 'Quota exceeded' } } }]);
    const uploadError = await upload.failure('submit');
    expect(uploadError.status).toBe(429);
    expect(uploadError.retryable).toBe(true);
    expect(upload.calls).toHaveLength(2);

    const publish = harness([status(), uploaded, { status: 503, text: 'unavailable' }]);
    const publishError = await publish.failure('submit');
    expect(publishError.stage).toBe('publish');
    expect(publishError.retryable).toBe(true);
    expect(publish.logs).toContain(`Upload succeeded: draft version ${VERSION}.`);
  });

  it('reports a publish rejected by the store (listing incomplete) as needing manual work', async () => {
    const h = harness([status(), uploaded, { status: 400, body: { error: { message: 'Publish condition not met: listing incomplete' } } }]);
    const error = await h.failure('submit');
    expect(error.stage).toBe('publish');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/listing incomplete/);
  });

  it('wraps network failures and timeouts as retryable without the token', async () => {
    const h = harness([]);
    const deps = { ...h.deps, fetch: (() => Promise.reject(new Error('fetch failed: ETIMEDOUT'))) as typeof globalThis.fetch };
    const error = await recoverStoreRelease({ publisher: PUBLISHER, item: ITEM, zip: ZIP, expectedVersion: VERSION, action: 'submit', token: TOKEN, replaceDraft: true }, deps).then(
      () => {
        throw new Error('expected recoverStoreRelease to fail');
      },
      (e: unknown) => e as StoreError
    );
    expect(error).toBeInstanceOf(StoreError);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/could not reach the Chrome Web Store: fetch failed: ETIMEDOUT/);
    h.nothingLeaked(error);
  });

  it('rejects responses it cannot interpret', async () => {
    expect((await harness([{ text: 'not json' }]).failure('submit')).message).toMatch(/unexpected response body/);
    expect((await harness([{ body: [1, 2] }]).failure('submit')).message).toMatch(/unexpected response body/);
    const unknownUpload = await harness([status(), { body: { itemId: ITEM } }]).failure('submit');
    expect(unknownUpload.message).toMatch(/state UNKNOWN/);
  });

  it('validates inputs before any network call', async () => {
    const h = harness([]);
    expect((await h.failure('submit', { item: 'nope' })).message).toMatch(/not a Chrome Web Store extension id/);
    expect((await h.failure('submit', { token: '' })).message).toMatch(/CWS_ACCESS_TOKEN is not set/);
    expect((await h.failure('submit', { zip: Buffer.alloc(0) })).message).toMatch(/package is empty/);
    expect((await h.failure('nonsense' as Action)).message).toMatch(/unknown action/);
    expect((await h.failure('submit', { replaceDraft: 'yes' as unknown as boolean })).message).toMatch(/replaceDraft must be true or false/);
    expect(h.calls).toHaveLength(0);
  });
});

describe('recoverStoreRelease: repeated runs against the same store', () => {
  const deps = (fetch: typeof globalThis.fetch) => ({ fetch, sleep: () => Promise.resolve(), now: () => 0, pollIntervalMs: 1, timeoutMs: 1_000 });
  const options = (action: Action): Options => ({ publisher: PUBLISHER, item: ITEM, zip: ZIP, expectedVersion: VERSION, action, token: TOKEN, replaceDraft: true });

  it('a duplicate execution after a submission reports in-review and changes nothing', async () => {
    const store = fakeStore();
    const first = await recoverStoreRelease(options('submit'), deps(store.fetch));
    expect(first.outcome).toBe('submitted');
    expect(store.state).toMatchObject({ uploads: 1, publishes: 1, submitted: { state: 'PENDING_REVIEW', version: VERSION } });
    const second = await recoverStoreRelease(options('submit'), deps(store.fetch));
    expect(second).toMatchObject({ outcome: 'in-review', mutated: false });
    expect(store.state).toMatchObject({ uploads: 1, publishes: 1 });
  });

  it('a repeated upload-only retry uploads the same verified package again and never submits', async () => {
    const store = fakeStore();
    await recoverStoreRelease(options('upload'), deps(store.fetch));
    await recoverStoreRelease(options('upload'), deps(store.fetch));
    expect(store.state).toMatchObject({ uploads: 2, publishes: 0, submitted: null, draft: VERSION });
  });

  it('a retry that follows a published release changes nothing', async () => {
    const store = fakeStore({ published: VERSION });
    const result = await recoverStoreRelease(options('submit'), deps(store.fetch));
    expect(result).toMatchObject({ outcome: 'published', mutated: false });
    expect(store.state).toMatchObject({ uploads: 0, publishes: 0 });
  });

  it('a retry while another version is under review stops before mutating', async () => {
    const store = fakeStore({ submitted: { state: 'PENDING_REVIEW', version: '1.2.4' } });
    await expect(recoverStoreRelease(options('submit'), deps(store.fetch))).rejects.toMatchObject({ stage: 'reconcile', retryable: false });
    expect(store.state).toMatchObject({ uploads: 0, publishes: 0 });
  });
});

describe('shared vocabulary between the Release and Retry workflows', () => {
  it('maps the workflow store inputs onto the client actions', () => {
    expect(storeActionFromInput('upload-only')).toBe('upload');
    expect(storeActionFromInput('submit-for-review')).toBe('submit');
    expect(storeActionFromInput('submit-staged')).toBe('submit-staged');
    expect(storeActionFromInput('upload')).toBe('upload');
    expect(storeActionFromInput('submit')).toBe('submit');
    expect(storeActionFromInput('none')).toBeNull();
    expect(storeActionFromInput(undefined)).toBeNull();
    expect(storeActionFromInput('publish')).toBeNull();
    expect(publishTypeFor('upload')).toBeNull();
    expect(publishTypeFor('submit')).toBe('DEFAULT_PUBLISH');
    expect(publishTypeFor('submit-staged')).toBe('STAGED_PUBLISH');
  });

  it('describes every outcome without claiming approval or availability', () => {
    for (const outcome of ['uploaded', 'submitted', 'in-review', 'staged', 'published'] as const) {
      const line = describeOutcome(outcome, VERSION);
      expect(line).toContain(VERSION);
      if (outcome !== 'published') expect(line).not.toMatch(/now live|publicly available|has been approved/);
    }
    expect(describeOutcome('submitted', VERSION)).toMatch(/Acceptance is not approval/);
    expect(describeOutcome('uploaded', VERSION)).toMatch(/has not been submitted/);
    expect(describeOutcome('published', VERSION)).toMatch(/nothing was changed/);
  });

  it('the client sends the bearer token only in the Authorization header and marks transient statuses retryable', async () => {
    const net = scriptedFetch([status(), { status: 500, text: 'boom' }]);
    const client = createStoreClient({ publisher: PUBLISHER, item: ITEM, token: TOKEN }, { fetch: net.fetch, sleep: () => Promise.resolve(), maxStatusRetries: 0 });
    await client.fetchStatus();
    expect(net.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(net.calls[0]!.url).toBe(STATUS_URL);
    const error = await client.fetchStatus().catch((e: unknown) => e as StoreError);
    expect(error).toMatchObject({ name: 'StoreError', status: 500, retryable: true });
    expect(new StoreError('x', { stage: 'input' }).retryable).toBe(false);
    expect(new StoreError('x', { stage: 'status', status: 429 }).retryable).toBe(true);
    expect(new StoreError('x', { stage: 'status', status: 400 }).retryable).toBe(false);
  });
});
