/**
 * Downloads and verifies the package of an existing GitHub Release so the Chrome Web Store step
 * can be retried with exactly the bytes that were released. Nothing is built, tagged or published.
 *
 *   GITHUB_TOKEN=... node scripts/release/fetch-release.mjs --version 1.0.0 --repository owner/TokenLens [--out release] [--api-base https://api.github.com]
 *
 * Writes TokenLens-v<version>.zip, its .sha256 and provenance.json (when the release carries one)
 * into --out, after checking the checksum, the package structure, the manifest version and the
 * provenance schema. Exit 1 with `::error::` when the release is missing, incomplete or fails
 * verification; `retry_safe` in GITHUB_OUTPUT says whether re-running later can help.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchVerifiedReleasePackage, GITHUB_API, ReleaseError } from './lib/github-release.mjs';
import { VERSION_PATTERN } from './lib/version.mjs';

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
  output(`retry_safe=${retrySafe}`);
  summary(retrySafe ? 'Re-running later may succeed.' : 'Manual intervention is required before retrying.');
  process.exit(1);
};

const version = option('version') ?? '';
const repository = option('repository') ?? process.env.GITHUB_REPOSITORY ?? '';
const outDir = option('out') ?? 'release';
if (!VERSION_PATTERN.test(version) || !repository) {
  console.error('usage: node scripts/release/fetch-release.mjs --version X.Y.Z --repository owner/name [--out release] [--api-base URL]');
  process.exit(2);
}

try {
  const result = await fetchVerifiedReleasePackage(
    { repository, version, token: process.env.GITHUB_TOKEN ?? '' },
    { fetch, apiBase: option('api-base') ?? process.env.GITHUB_API_URL ?? GITHUB_API, log: summary }
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, result.zipName), result.zip);
  writeFileSync(join(outDir, `${result.zipName}.sha256`), result.checksumText);
  if (result.provenance !== null) writeFileSync(join(outDir, 'provenance.json'), `${JSON.stringify(result.provenance, null, 2)}\n`);
  output(`tag=${result.tag}`);
  output(`zip_name=${result.zipName}`);
  output(`sha256=${result.sha256}`);
  output(`release_url=${result.releaseUrl ?? ''}`);
  summary(`Reusing the released package ${result.zipName} (SHA-256 ${result.sha256}); nothing was rebuilt.`);
} catch (error) {
  if (error instanceof ReleaseError) fail(error.message, error.retryable);
  throw error;
}
