/**
 * Chrome Web Store API v2 client used by the Release and Retry workflows. Pure with respect to
 * its environment: HTTP, time and logging are injected so every flow is tested without the store.
 *
 * Endpoints (https://developer.chrome.com/docs/webstore/api/reference/rest):
 *   POST /upload/v2/publishers/{publisher}/items/{item}:upload   body: the ZIP
 *   GET  /v2/publishers/{publisher}/items/{item}:fetchStatus      published/submitted revisions, last upload state
 *   POST /v2/publishers/{publisher}/items/{item}:publish          body: { publishType }
 *
 * Upload states: SUCCEEDED, IN_PROGRESS (the prose also spells it UPLOAD_IN_PROGRESS), FAILED,
 * NOT_FOUND, UPLOAD_STATE_UNSPECIFIED. Item states: PENDING_REVIEW, STAGED, PUBLISHED,
 * PUBLISHED_TO_TESTERS, REJECTED, CANCELLED. Publish types: DEFAULT_PUBLISH (live once approved)
 * and STAGED_PUBLISH (waits in the dashboard after approval). "Submitted" never means
 * "published": review timing and outcome belong to Google and are reported from the API only.
 *
 * fetchStatus reports the versions of the published and the submitted revision but nothing about
 * an unsubmitted draft except whether an upload happened in the last 24 hours. The recovery flow
 * therefore never assumes a draft is the release package: it either finds the version already
 * submitted or published and leaves the store alone, or it re-uploads the verified package.
 */
import { compareVersions, VERSION_PATTERN } from './version.mjs';

export const CWS_API = 'https://chromewebstore.googleapis.com';
export const STORE_ACTIONS = /** @type {const} */ (['upload', 'submit', 'submit-staged']);
export const UPLOAD_IN_PROGRESS_STATES = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Workflow input names and the internal action they map to. */
const STORE_INPUT_ACTIONS = /** @type {Record<string, 'upload' | 'submit' | 'submit-staged'>} */ ({
  'upload-only': 'upload',
  'submit-for-review': 'submit',
  'submit-staged': 'submit-staged',
  upload: 'upload',
  submit: 'submit',
});

/**
 * Maps a workflow `store` input (or an internal action name) to the internal action.
 * @param {string | undefined} value
 * @returns {'upload' | 'submit' | 'submit-staged' | null} null when unknown or `none`
 */
export function storeActionFromInput(value) {
  return STORE_INPUT_ACTIONS[String(value ?? '').trim()] ?? null;
}

/**
 * @param {'upload' | 'submit' | 'submit-staged'} action
 * @returns {'DEFAULT_PUBLISH' | 'STAGED_PUBLISH' | null}
 */
export function publishTypeFor(action) {
  return action === 'submit' ? 'DEFAULT_PUBLISH' : action === 'submit-staged' ? 'STAGED_PUBLISH' : null;
}

/**
 * A failed store interaction with an actionable message. Never carries the access token.
 * `retryable` says whether re-running the same workflow later is a sensible next step (rate limits,
 * server errors, network failures, uploads still processing) or whether a person must look at the
 * Developer Dashboard first.
 */
export class StoreError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, stage: 'upload' | 'status' | 'publish' | 'input' | 'reconcile', retryable?: boolean }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'StoreError';
    this.status = info.status;
    this.stage = info.stage;
    this.retryable = info.retryable ?? (info.status !== undefined && RETRYABLE_STATUS.has(info.status));
  }
}

/**
 * @typedef {object} StoreCredentials
 * @property {string} publisher Chrome Web Store publisher id
 * @property {string} item 32-character extension id of an existing store item
 * @property {string} token short-lived OAuth access token with the chromewebstore scope
 */

/**
 * @typedef {object} StoreDeps
 * @property {typeof fetch} fetch
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {(line: string) => void} [log] progress lines fit for a job summary
 * @property {string} [apiBase]
 * @property {number} [pollIntervalMs] delay between fetchStatus polls (default 10 s)
 * @property {number} [timeoutMs] how long to wait for an in-progress upload (default 10 min)
 * @property {number} [maxStatusRetries] retries for transient fetchStatus failures (default 3)
 */

/** @typedef {StoreDeps} PublishDeps */

/**
 * @typedef {object} PublishOptions
 * @property {string} publisher
 * @property {string} item
 * @property {Buffer} zip package bytes
 * @property {string} expectedVersion manifest version the store must report back
 * @property {'upload' | 'submit' | 'submit-staged'} action how far to go after the upload
 * @property {string} token
 */

/**
 * @typedef {object} PublishResult
 * @property {string} uploadState
 * @property {string | undefined} crxVersion
 * @property {boolean} submitted true once the publish call was accepted
 * @property {'DEFAULT_PUBLISH' | 'STAGED_PUBLISH' | null} publishType
 * @property {string | null} itemState state reported by the publish response
 * @property {unknown} warnings warningInfo from the publish response, if any
 */

/**
 * @param {number} status
 * @param {string} method
 * @param {string} path
 * @param {string} detail
 */
function describeHttpFailure(status, method, path, detail) {
  const base = `${method} ${path} failed with HTTP ${status}`;
  const tail = detail ? `: ${detail}` : '';
  switch (status) {
    case 401:
      return `${base}${tail}. The access token was rejected; check the Workload Identity Federation setup and that the token carries the chromewebstore scope.`;
    case 403:
      return `${base}${tail}. The caller is not allowed to manage this item; add the service account to the publisher in the Developer Dashboard and enable the Chrome Web Store API on the Google Cloud project.`;
    case 404:
      return `${base}${tail}. Publisher or item not found; check CWS_PUBLISHER_ID and CWS_EXTENSION_ID (the item must be created once in the dashboard).`;
    case 429:
      return `${base}${tail}. The store rate-limited the request; wait and re-run the workflow.`;
    default:
      return status >= 500 ? `${base}${tail}. The store reported a server error; re-run the workflow later.` : `${base}${tail}`;
  }
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the identifiers and the token. The same messages are used by every entry point so the
 * workflows report configuration mistakes identically.
 * @param {{ publisher?: string, item?: string, expectedVersion?: string }} input
 */
function validateCredentials({ publisher, item, expectedVersion }) {
  if (!publisher || !item || !expectedVersion) throw new StoreError('missing publisher, item or expected version', { stage: 'input', retryable: false });
  if (!/^[a-p]{32}$/.test(item)) throw new StoreError(`"${item}" is not a Chrome Web Store extension id (32 letters a-p)`, { stage: 'input', retryable: false });
}

/**
 * @param {string} action
 * @returns {asserts action is 'upload' | 'submit' | 'submit-staged'}
 */
function validateAction(action) {
  if (!STORE_ACTIONS.includes(/** @type {any} */ (action))) throw new StoreError(`unknown action "${action}"; use ${STORE_ACTIONS.join(', ')}`, { stage: 'input', retryable: false });
}

/** @param {string | undefined} token */
function validateToken(token) {
  if (!token) throw new StoreError('no access token: CWS_ACCESS_TOKEN is not set; the workflow must obtain a short-lived token first', { stage: 'input', retryable: false });
}

/** @param {Buffer | undefined} zip */
function validateZip(zip) {
  if (!zip || zip.length === 0) throw new StoreError('the package is empty', { stage: 'input', retryable: false });
}

/**
 * HTTP client for one store item. Authentication lives in the closure and never in return values.
 * @param {StoreCredentials} credentials
 * @param {StoreDeps} deps
 */
export function createStoreClient({ publisher, item, token }, deps) {
  const { fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), apiBase = CWS_API, pollIntervalMs = 10_000, maxStatusRetries = 3 } = deps;
  const name = `publishers/${publisher}/items/${item}`;
  const headers = { Authorization: `Bearer ${token}`, 'x-goog-api-client': 'tokenlens-release' };

  /**
   * @param {'POST' | 'GET'} method
   * @param {string} path
   * @param {'upload' | 'status' | 'publish'} stage
   * @param {{ body?: BodyInit, contentType?: string }} [init]
   * @returns {Promise<Record<string, any>>}
   */
  async function call(method, path, stage, init = {}) {
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, { method, headers: { ...headers, ...(init.contentType ? { 'Content-Type': init.contentType } : {}) }, body: init.body });
    } catch (error) {
      throw new StoreError(`${method} ${path} could not reach the Chrome Web Store: ${error instanceof Error ? error.message : String(error)}`, { stage, retryable: true });
    }
    const text = await response.text();
    /** @type {unknown} */
    let json = null;
    let parsed = text.length === 0;
    try {
      json = text ? JSON.parse(text) : null;
      parsed = true;
    } catch {
      // Non-JSON bodies are reported verbatim (truncated) in the errors below.
    }
    if (!response.ok) {
      const detail = isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string' ? json.error.message : text.slice(0, 500);
      throw new StoreError(describeHttpFailure(response.status, method, path, detail), { status: response.status, stage });
    }
    if (!parsed || (json !== null && !isRecord(json))) {
      throw new StoreError(`${method} ${path} returned an unexpected response body: ${text.slice(0, 200)}`, { status: response.status, stage, retryable: false });
    }
    return json === null ? {} : json;
  }

  return {
    name,
    /** fetchStatus is idempotent, so transient failures are retried with backoff. */
    async fetchStatus() {
      for (let attempt = 0; ; attempt++) {
        try {
          return await call('GET', `/v2/${name}:fetchStatus`, 'status');
        } catch (error) {
          const transient = error instanceof StoreError && error.status !== undefined && RETRYABLE_STATUS.has(error.status);
          if (!transient || attempt >= maxStatusRetries) throw error;
          await sleep(pollIntervalMs * (attempt + 1));
        }
      }
    },
    /** Uploads are not idempotent, so they are never retried automatically. @param {Buffer} zip */
    upload(zip) {
      return call('POST', `/upload/v2/${name}:upload`, 'upload', { body: zip, contentType: 'application/zip' });
    },
    /** @param {'DEFAULT_PUBLISH' | 'STAGED_PUBLISH'} publishType */
    publish(publishType) {
      return call('POST', `/v2/${name}:publish`, 'publish', { body: JSON.stringify({ publishType }), contentType: 'application/json' });
    },
  };
}

/** @typedef {ReturnType<typeof createStoreClient>} StoreClient */

/** @param {Record<string, any>} response */
const uploadStateOf = (response) => (typeof response.uploadState === 'string' ? response.uploadState : typeof response.lastAsyncUploadState === 'string' ? response.lastAsyncUploadState : 'UNKNOWN');

/**
 * Uploads the package, waits for the store to finish processing it and checks that the store
 * accepted exactly the expected version.
 * @param {StoreClient} client
 * @param {{ zip: Buffer, expectedVersion: string, item: string }} input
 * @param {StoreDeps} deps
 * @returns {Promise<{ uploadState: string, crxVersion: string | undefined }>}
 */
async function uploadPackage(client, { zip, expectedVersion, item }, deps) {
  const { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {}, pollIntervalMs = 10_000, timeoutMs = 10 * 60 * 1000 } = deps;

  log(`Uploading ${zip.length} bytes to Chrome Web Store item ${item}…`);
  let upload = await client.upload(zip);
  const deadline = now() + timeoutMs;
  let polled = false;
  while (UPLOAD_IN_PROGRESS_STATES.has(uploadStateOf(upload))) {
    if (now() >= deadline) {
      throw new StoreError(`the upload was still in progress after ${Math.round(timeoutMs / 60_000)} minutes. Check the item in the Developer Dashboard before re-running; a second upload of the same version is rejected.`, { stage: 'status', retryable: true });
    }
    await sleep(pollIntervalMs);
    upload = await client.fetchStatus();
    polled = true;
  }

  const uploadState = uploadStateOf(upload);
  if (uploadState !== 'SUCCEEDED') {
    const detail = JSON.stringify(upload.itemError ?? upload).slice(0, 500);
    const hint = uploadState === 'NOT_FOUND' ? ' (the store has no record of the upload)' : uploadState === 'UNKNOWN' ? ' (the response did not include an upload state)' : '';
    throw new StoreError(`upload did not succeed (state ${uploadState})${hint}: ${detail}`, { stage: polled ? 'status' : 'upload', retryable: false });
  }
  const crxVersion = typeof upload.crxVersion === 'string' ? upload.crxVersion : undefined;
  if (crxVersion !== undefined && crxVersion !== expectedVersion) {
    throw new StoreError(`the store accepted version ${crxVersion}, expected ${expectedVersion}; the uploaded package does not match the release`, { stage: 'upload', retryable: false });
  }
  log(`Upload succeeded: draft version ${crxVersion ?? expectedVersion}.`);
  return { uploadState, crxVersion };
}

/**
 * Submits the current draft for review.
 * @param {StoreClient} client
 * @param {'DEFAULT_PUBLISH' | 'STAGED_PUBLISH'} publishType
 * @param {StoreDeps} deps
 * @returns {Promise<{ itemState: string | null, warnings: unknown }>}
 */
async function submitDraft(client, publishType, deps) {
  const { log = () => {} } = deps;
  const published = await client.publish(publishType);
  const itemState = typeof published.state === 'string' ? published.state : null;
  log(`Submitted for review with ${publishType}. Item state: ${itemState ?? 'unknown'}.`);
  if (published.warningInfo) log(`Store warnings: ${JSON.stringify(published.warningInfo).slice(0, 1000)}`);
  log(
    publishType === 'STAGED_PUBLISH'
      ? 'After Google approves the submission it stays staged until it is published from the Developer Dashboard.'
      : 'After Google approves the submission it is published automatically. Approval timing is outside this workflow.'
  );
  return { itemState, warnings: published.warningInfo };
}

/**
 * Uploads a package and, depending on `action`, submits it for review. Used by the Release
 * workflow, where no earlier attempt exists for the version.
 * @param {PublishOptions} options
 * @param {StoreDeps} deps
 * @returns {Promise<PublishResult>}
 */
export async function publishToStore(options, deps) {
  const { publisher, item, zip, expectedVersion, action, token } = options;
  validateCredentials({ publisher, item, expectedVersion });
  validateAction(action);
  validateToken(token);
  validateZip(zip);
  const { log = () => {} } = deps;

  const client = createStoreClient({ publisher, item, token }, deps);
  const { uploadState, crxVersion } = await uploadPackage(client, { zip, expectedVersion, item }, deps);

  const publishType = publishTypeFor(action);
  if (publishType === null) {
    log('No submission requested. Review and submit the draft in the Chrome Web Store Developer Dashboard.');
    return { uploadState, crxVersion, submitted: false, publishType: null, itemState: null, warnings: undefined };
  }
  const { itemState, warnings } = await submitDraft(client, publishType, deps);
  return { uploadState, crxVersion, submitted: true, publishType, itemState, warnings };
}

/**
 * @typedef {object} RevisionSummary
 * @property {string | null} state
 * @property {string[]} versions crxVersion of every distribution channel
 */

/**
 * @typedef {object} Reconciliation
 * @property {'already-published' | 'in-review' | 'staged' | 'upload-in-progress' | 'upload-needed' | 'conflict' | 'blocked'} decision
 * @property {string} detail human-readable reasoning fit for a job summary
 * @property {RevisionSummary | null} published
 * @property {RevisionSummary | null} submitted
 * @property {string | null} lastUploadState
 */

/** @param {unknown} revision @returns {RevisionSummary | null} */
function summariseRevision(revision) {
  if (!isRecord(revision)) return null;
  const channels = Array.isArray(revision.distributionChannels) ? revision.distributionChannels : [];
  const versions = channels.map((c) => (isRecord(c) && typeof c.crxVersion === 'string' ? c.crxVersion : null)).filter((v) => v !== null);
  return { state: typeof revision.state === 'string' ? revision.state : null, versions: /** @type {string[]} */ (versions) };
}

/**
 * Decides what a retry may do from a fetchStatus response, without touching the store. The rules
 * are deliberately conservative: a version that the store already shows as submitted or published
 * is left alone, any other version in flight is a conflict that a person must resolve, and an
 * unsubmitted draft is never trusted because the API cannot say what it contains.
 * @param {Record<string, any>} status fetchStatus response
 * @param {{ version: string }} expected
 * @returns {Reconciliation}
 */
export function reconcileStoreStatus(status, { version }) {
  const published = summariseRevision(status.publishedItemRevisionStatus);
  const submitted = summariseRevision(status.submittedItemRevisionStatus);
  const lastUploadState = typeof status.lastAsyncUploadState === 'string' ? status.lastAsyncUploadState : null;
  /** @param {Reconciliation['decision']} decision @param {string} detail @returns {Reconciliation} */
  const result = (decision, detail) => ({ decision, detail, published, submitted, lastUploadState });

  if (status.takenDown === true) {
    return result('blocked', 'the store item has been taken down for a policy violation; resolve it in the Developer Dashboard before publishing anything');
  }
  if (published && published.versions.includes(version)) {
    return result('already-published', `version ${version} is already published (state ${published.state ?? 'unknown'}); nothing to do`);
  }
  if (submitted) {
    const label = submitted.versions.length > 0 ? submitted.versions.join(', ') : 'an unknown version';
    if (submitted.versions.length === 0) {
      return result('conflict', `the store reports a submitted revision without a version (state ${submitted.state ?? 'unknown'}); check the Developer Dashboard before retrying`);
    }
    if (!submitted.versions.includes(version)) {
      return result('conflict', `version ${label} is already submitted (state ${submitted.state ?? 'unknown'}); wait for its review to finish or cancel it in the Developer Dashboard before retrying ${version}`);
    }
    switch (submitted.state) {
      case 'PENDING_REVIEW':
        return result('in-review', `version ${version} is already submitted and pending review; no second submission is made`);
      case 'STAGED':
        return result('staged', `version ${version} was approved and is staged; publish it from the Developer Dashboard when ready`);
      case 'PUBLISHED':
      case 'PUBLISHED_TO_TESTERS':
        return result('already-published', `version ${version} is already published (state ${submitted.state}); nothing to do`);
      case 'REJECTED':
        return result('blocked', `the submission of version ${version} was rejected; read the review message in the Developer Dashboard, fix the cause, and decide there whether to resubmit`);
      case 'CANCELLED':
        break;
      default:
        return result('conflict', `version ${version} is submitted in an unexpected state (${submitted.state ?? 'unknown'}); check the Developer Dashboard before retrying`);
    }
  }
  if (published) {
    const higher = published.versions.filter((v) => VERSION_PATTERN.test(v) && VERSION_PATTERN.test(version) && compareVersions(v, version) > 0);
    if (higher.length > 0) {
      return result('conflict', `the store already publishes version ${higher.join(', ')}, which is higher than ${version}; the store rejects lower versions, so this release cannot be retried`);
    }
  }
  if (lastUploadState !== null && UPLOAD_IN_PROGRESS_STATES.has(lastUploadState)) {
    return result('upload-in-progress', 'an earlier upload is still being processed by the store; waiting for it to finish');
  }
  const history =
    lastUploadState === 'SUCCEEDED'
      ? 'an upload succeeded within the last 24 hours but was not submitted'
      : lastUploadState === 'FAILED'
        ? 'the last upload failed'
        : lastUploadState === 'NOT_FOUND'
          ? 'the store has no record of a recent upload'
          : 'no upload was recorded in the last 24 hours';
  return result('upload-needed', `${history}. The API does not expose an unsubmitted draft's version or content, so the verified release package is uploaded and replaces whatever draft exists.`);
}

/**
 * @typedef {object} RecoverOptions
 * @property {string} publisher
 * @property {string} item
 * @property {string} token
 * @property {Buffer} zip verified release package
 * @property {string} expectedVersion
 * @property {'upload' | 'submit' | 'submit-staged'} action
 * @property {boolean} replaceDraft explicit permission to replace an unsubmitted draft by uploading
 */

/**
 * @typedef {object} RecoverResult
 * @property {'uploaded' | 'submitted' | 'in-review' | 'staged' | 'published'} outcome
 * @property {boolean} mutated whether the store was changed by this run
 * @property {Reconciliation} reconciliation what the store reported before acting
 * @property {'DEFAULT_PUBLISH' | 'STAGED_PUBLISH' | null} publishType
 * @property {string | null} itemState state from the publish response, if a submission was made
 * @property {unknown} warnings
 */

/**
 * Resumes the Chrome Web Store part of an existing release. Inspects the store first and only
 * then uploads or submits; see `reconcileStoreStatus` for the policy.
 * @param {RecoverOptions} options
 * @param {StoreDeps} deps
 * @returns {Promise<RecoverResult>}
 */
export async function recoverStoreRelease(options, deps) {
  const { publisher, item, token, zip, expectedVersion, action, replaceDraft } = options;
  validateCredentials({ publisher, item, expectedVersion });
  validateAction(action);
  validateToken(token);
  validateZip(zip);
  if (typeof replaceDraft !== 'boolean') throw new StoreError('replaceDraft must be true or false', { stage: 'input', retryable: false });
  const { log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, pollIntervalMs = 10_000, timeoutMs = 10 * 60 * 1000 } = deps;

  const client = createStoreClient({ publisher, item, token }, deps);
  const publishType = publishTypeFor(action);

  log(`Checking the current state of Chrome Web Store item ${item} for version ${expectedVersion}…`);
  const deadline = now() + timeoutMs;
  let reconciliation = reconcileStoreStatus(await client.fetchStatus(), { version: expectedVersion });
  while (reconciliation.decision === 'upload-in-progress') {
    if (now() >= deadline) {
      throw new StoreError(`an earlier upload was still being processed after ${Math.round(timeoutMs / 60_000)} minutes; re-run the retry later or check the item in the Developer Dashboard`, { stage: 'status', retryable: true });
    }
    log(reconciliation.detail);
    await sleep(pollIntervalMs);
    reconciliation = reconcileStoreStatus(await client.fetchStatus(), { version: expectedVersion });
  }
  log(`Store state: ${reconciliation.detail}`);

  /** @param {RecoverResult['outcome']} outcome @returns {RecoverResult} */
  const unchanged = (outcome) => ({ outcome, mutated: false, reconciliation, publishType, itemState: reconciliation.submitted?.state ?? null, warnings: undefined });

  switch (reconciliation.decision) {
    case 'already-published':
      return unchanged('published');
    case 'in-review':
      return unchanged('in-review');
    case 'staged':
      return unchanged('staged');
    case 'conflict':
    case 'blocked':
      throw new StoreError(`${reconciliation.detail}. Nothing was uploaded or submitted.`, { stage: 'reconcile', retryable: false });
    default:
      break;
  }

  if (!replaceDraft) {
    throw new StoreError(
      `${reconciliation.detail} Re-run with replace_draft enabled to upload it, after checking in the Developer Dashboard that no unsubmitted draft must be kept. Nothing was uploaded or submitted.`,
      { stage: 'reconcile', retryable: false }
    );
  }

  await uploadPackage(client, { zip, expectedVersion, item }, deps);
  if (publishType === null) {
    log('No submission requested. Review and submit the draft in the Chrome Web Store Developer Dashboard.');
    return { outcome: 'uploaded', mutated: true, reconciliation, publishType, itemState: null, warnings: undefined };
  }
  const { itemState, warnings } = await submitDraft(client, publishType, deps);
  return { outcome: 'submitted', mutated: true, reconciliation, publishType, itemState, warnings };
}

/**
 * One line per outcome for job summaries. Acceptance of a submission is never described as
 * approval or availability.
 * @param {RecoverResult['outcome']} outcome
 * @param {string} version
 */
export function describeOutcome(outcome, version) {
  switch (outcome) {
    case 'uploaded':
      return `Upload succeeded: version ${version} is a draft in the Developer Dashboard and has not been submitted.`;
    case 'submitted':
      return `Submission accepted: version ${version} is in Google's review queue. Acceptance is not approval; the outcome is decided by Google.`;
    case 'in-review':
      return `In review: version ${version} was already submitted; no second submission was made.`;
    case 'staged':
      return `Staged: version ${version} is approved and waits to be published from the Developer Dashboard; nothing was changed.`;
    case 'published':
      return `Already published: the store already serves version ${version}; nothing was changed.`;
    default:
      return `Outcome: ${String(outcome)}`;
  }
}
