/**
 * Resumes the Chrome Web Store part of an existing release: inspects the store item first, then
 * uploads the verified release package and/or submits it only when the store does not already show
 * that version as submitted or published.
 *
 *   CWS_ACCESS_TOKEN=... node scripts/release/cws-recover.mjs \
 *     --publisher <publisherId> --item <extensionId> --zip release/TokenLens-v1.0.0.zip \
 *     --expect-version 1.0.0 --action upload-only|submit-for-review|submit-staged [--replace-draft true|false] [--api-base URL]
 *
 * Outcomes (GITHUB_OUTPUT `outcome`): uploaded, submitted, in-review, staged, published. A
 * submission that was accepted is never reported as approved or live. On failure the exit code is
 * 1 and `retry_safe` says whether re-running later is sensible or a person must look at the
 * Developer Dashboard first. The access token is read from the environment and never logged.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CWS_API, describeOutcome, recoverStoreRelease, storeActionFromInput, StoreError } from './lib/cws.mjs';
import { parseWorkflowBoolean } from './lib/inputs.mjs';

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
  summary(retrySafe ? 'Failed: re-running the retry later may succeed.' : 'Failed: manual intervention in the Developer Dashboard is required before retrying.');
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

const action = storeActionFromInput(option('action'));
if (action === null) fail(`unknown --action "${option('action') ?? ''}"; use upload-only, submit-for-review or submit-staged`, false);
const version = option('expect-version') ?? '';

summary(`Package: ${basename(zipPath)} (${zip.length} bytes), version ${version}, action ${option('action')}.`);
try {
  const result = await recoverStoreRelease(
    {
      publisher: option('publisher') ?? '',
      item: option('item') ?? '',
      zip,
      expectedVersion: version,
      action,
      token: process.env.CWS_ACCESS_TOKEN ?? '',
      replaceDraft: parseWorkflowBoolean(option('replace-draft')),
    },
    { fetch, log: summary, apiBase: option('api-base') ?? CWS_API }
  );
  output(`outcome=${result.outcome}`);
  output(`mutated=${result.mutated}`);
  output('retry_safe=true');
  summary(describeOutcome(result.outcome, version));
} catch (error) {
  if (error instanceof StoreError) fail(error.message, error.retryable);
  throw error;
}
