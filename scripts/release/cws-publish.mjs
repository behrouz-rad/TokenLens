/**
 * Uploads a verified package to an existing Chrome Web Store item through the Chrome Web Store
 * API v2 and, if asked, submits it for review. Used by the Release workflow for a version that has
 * never been uploaded; an interrupted release is resumed with cws-recover.mjs instead.
 *
 *   CWS_ACCESS_TOKEN=... node scripts/release/cws-publish.mjs \
 *     --publisher <publisherId> --item <extensionId> --zip release/TokenLens-v1.0.0.zip \
 *     --expect-version 1.0.0 --action upload-only|submit-for-review|submit-staged
 *
 * Actions (the workflow's own names; the short forms upload and submit are accepted too):
 *   upload-only        upload the package as a new draft; nothing is submitted
 *   submit-for-review  upload, then publish with DEFAULT_PUBLISH: the item is submitted for review
 *                      and goes live automatically once Google approves it
 *   submit-staged      upload, then publish with STAGED_PUBLISH: after approval the release waits
 *                      in the dashboard until the owner publishes it by hand
 *
 * The access token is read from the environment and never written to logs. "Submitted" is not
 * "published": review timing is Google's, and the final state is reported from the API response.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describeOutcome, publishToStore, storeActionFromInput, StoreError } from './lib/cws.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const output = (line) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
};
const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};
const fail = (message, retrySafe) => {
  console.error(`::error::${message}`);
  output('outcome=failed');
  output(`retry_safe=${retrySafe}`);
  summary(retrySafe ? 'Failed: the Retry Chrome Web Store workflow can resume this release later.' : 'Failed: check the Developer Dashboard, then resume with the Retry Chrome Web Store workflow.');
  process.exit(1);
};

const zipPath = option('zip');
if (!zipPath) fail('missing --zip', false);
let zip;
try {
  zip = readFileSync(zipPath);
} catch (error) {
  fail(`cannot read ${zipPath}: ${error instanceof Error ? error.message : String(error)}`, false);
}

const action = storeActionFromInput(option('action') ?? 'upload-only');
if (action === null) fail(`unknown --action "${option('action') ?? ''}"; use upload-only, submit-for-review or submit-staged`, false);
const version = option('expect-version') ?? '';

summary(`Package: ${basename(zipPath)} (${zip.length} bytes)`);
try {
  const result = await publishToStore(
    {
      publisher: option('publisher') ?? '',
      item: option('item') ?? '',
      zip,
      expectedVersion: version,
      action,
      token: process.env.CWS_ACCESS_TOKEN ?? '',
    },
    { fetch, log: summary }
  );
  const outcome = result.submitted ? 'submitted' : 'uploaded';
  output(`outcome=${outcome}`);
  output('retry_safe=true');
  summary(describeOutcome(outcome, version));
} catch (error) {
  if (error instanceof StoreError) fail(error.message, error.retryable);
  throw error;
}
