/**
 * Builds and verifies the release ZIP. Shared by the package and verify CLIs and their tests.
 *
 * Verification re-opens the archive and checks that `manifest.json` sits at its root with the
 * expected version and the extension's security posture, that nothing from the development tree
 * slipped in, that no bundle contains development-only data, and (optionally) that the archive
 * holds exactly the files of a given `dist/` directory.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listFiles, readZipEntries, readZipEntry, zipDirectory } from '../zip.mjs';

/** Patterns that must never ship inside the store package. */
export const FORBIDDEN_ENTRIES = [
  /\.map$/i,
  /(^|\/)\.env/i,
  /(^|\/)node_modules\//i,
  /(^|\/)\.git(\/|$)/i,
  /\.(ts|tsx|test\.[cm]?js|spec\.[cm]?js)$/i,
  /(^|\/)(test|tests|e2e|coverage|docs)\//i,
  /\.DS_Store$/i,
  /Thumbs\.db$/i,
  /\.(pem|key|p12|pfx)$/i,
];

/** Strings that indicate development-only code or fixtures leaked into the production bundle. */
export const FORBIDDEN_CONTENT = ['createMockObservations', 'synthetic-signature-not-real', 'c3ludGhldGljLXNpZ25hdHVyZS1ub3QtcmVhbA', 'BEGIN PRIVATE KEY', 'BEGIN RSA PRIVATE KEY', 'AKIA', 'ghp_', 'xox'];

const JWT_LITERAL = /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/;
const TEXT_ENTRY = /\.(js|mjs|html|css|json)$/i;

/** @param {string} version */
export function zipNameFor(version) {
  return `TokenLens-v${version}.zip`;
}

/** @param {Buffer} bytes */
export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Structural verification of a packaged extension.
 * @param {Buffer} zip
 * @param {{ version: string }} options
 * @returns {{ problems: string[], entries: string[], manifest: Record<string, any> | null }}
 */
export function verifyPackage(zip, { version }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {import('../zip.mjs').ZipEntry[]} */
  let entries;
  try {
    entries = readZipEntries(zip);
  } catch (error) {
    return { problems: [error instanceof Error ? error.message : String(error)], entries: [], manifest: null };
  }
  if (entries.length === 0) problems.push('archive is empty');

  for (const entry of entries) {
    if (entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').includes('..')) problems.push(`unsafe entry path: ${entry.name}`);
    for (const pattern of FORBIDDEN_ENTRIES) if (pattern.test(entry.name)) problems.push(`development file packaged: ${entry.name}`);
  }

  /** @type {Record<string, any> | null} */
  let manifest = null;
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) problems.push('manifest.json is not at the root of the archive');
  else {
    try {
      manifest = JSON.parse(readZipEntry(zip, manifestEntry).toString('utf8'));
    } catch (error) {
      problems.push(`manifest.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (manifest) {
    if (manifest.version !== version) problems.push(`manifest version is ${manifest.version}, expected ${version}`);
    if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
    if (!Array.isArray(manifest.permissions) || manifest.permissions.length > 0) problems.push('permissions must be empty');
    if (manifest.host_permissions?.length) problems.push('host_permissions must be empty');
    if (manifest.background || manifest.content_scripts) problems.push('no background worker or content scripts are allowed');
    for (const required of [manifest.devtools_page, ...Object.values(manifest.icons ?? {})]) {
      if (typeof required === 'string' && !entries.some((e) => e.name === required)) problems.push(`manifest references missing file ${required}`);
    }
  }

  for (const entry of entries) {
    if (!TEXT_ENTRY.test(entry.name)) continue;
    let text;
    try {
      text = readZipEntry(zip, entry).toString('utf8');
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const needle of FORBIDDEN_CONTENT) if (text.includes(needle)) problems.push(`${entry.name} contains forbidden content "${needle}"`);
    if (JWT_LITERAL.test(text)) problems.push(`${entry.name} contains a JWT-shaped literal`);
  }

  return { problems, entries: entries.map((e) => e.name), manifest };
}

/**
 * Checks that the archive holds exactly the files under `distDir`, byte for byte. This is how a
 * later job proves that the build it tested is the build that was packaged.
 * @param {Buffer} zip
 * @param {string} distDir
 * @returns {string[]} problems
 */
export function verifyPackageMatchesDist(zip, distDir) {
  /** @type {string[]} */
  const problems = [];
  if (!existsSync(distDir)) return [`${distDir} does not exist`];
  const files = listFiles(distDir);
  const entries = readZipEntries(zip);
  const byName = new Map(entries.map((e) => [e.name, e]));
  for (const file of files) {
    const entry = byName.get(file);
    if (!entry) {
      problems.push(`${file} is in dist but not in the archive`);
      continue;
    }
    const expected = readFileSync(join(distDir, ...file.split('/')));
    if (!readZipEntry(zip, entry).equals(expected)) problems.push(`${file} differs between dist and the archive`);
    byName.delete(file);
  }
  for (const name of byName.keys()) problems.push(`${name} is in the archive but not in dist`);
  return problems;
}

/**
 * Describes where a package came from. Only facts the packaging step can observe are recorded;
 * nothing here claims that a signature or a store review happened.
 * @param {{ zipName: string, version: string, sha256: string, bytes: number, entries: number, env?: NodeJS.ProcessEnv, nodeVersion?: string }} input
 */
export function buildProvenance({ zipName, version, sha256, bytes, entries, env = process.env, nodeVersion = process.version }) {
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  return {
    name: zipName,
    version,
    sha256,
    bytes,
    entries,
    repository: env.GITHUB_REPOSITORY ?? null,
    commit: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF ?? null,
    workflowRun: runUrl,
    node: nodeVersion,
  };
}

/** Field names of `provenance.json` and a check for each value. */
const PROVENANCE_SCHEMA = /** @type {Record<string, (value: unknown) => boolean>} */ ({
  name: (v) => typeof v === 'string' && /^TokenLens-v\d+\.\d+\.\d+\.zip$/.test(v),
  version: (v) => typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v),
  sha256: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
  bytes: (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0,
  entries: (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0,
  repository: (v) => v === null || (typeof v === 'string' && /^[\w.-]+\/[\w.-]+$/.test(v)),
  commit: (v) => v === null || (typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v)),
  ref: (v) => v === null || typeof v === 'string',
  workflowRun: (v) => v === null || (typeof v === 'string' && /^https:\/\/\S+$/.test(v)),
  node: (v) => typeof v === 'string' && /^v\d+\.\d+\.\d+/.test(v),
});

/**
 * Checks a `provenance.json` against the schema `buildProvenance` writes and against the package
 * it claims to describe. Unknown or missing fields are problems: a retry must not act on a
 * provenance file it does not fully understand.
 * @param {unknown} provenance parsed JSON
 * @param {{ version: string, zipName: string, sha256: string, bytes: number, entries?: number }} expected
 * @returns {string[]} problems
 */
export function validateProvenance(provenance, expected) {
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) return ['provenance.json is not a JSON object'];
  /** @type {string[]} */
  const problems = [];
  const record = /** @type {Record<string, unknown>} */ (provenance);
  for (const [field, valid] of Object.entries(PROVENANCE_SCHEMA)) {
    if (!(field in record)) problems.push(`provenance.json is missing "${field}"`);
    else if (!valid(record[field])) problems.push(`provenance.json has an invalid "${field}": ${JSON.stringify(record[field]).slice(0, 120)}`);
  }
  for (const field of Object.keys(record)) if (!(field in PROVENANCE_SCHEMA)) problems.push(`provenance.json has an unexpected field "${field}"`);
  if (problems.length > 0) return problems;

  if (record.name !== expected.zipName) problems.push(`provenance.json describes ${String(record.name)}, expected ${expected.zipName}`);
  if (record.version !== expected.version) problems.push(`provenance.json records version ${String(record.version)}, expected ${expected.version}`);
  if (record.sha256 !== expected.sha256) problems.push(`provenance.json records SHA-256 ${String(record.sha256)}, but the package is ${expected.sha256}`);
  if (record.bytes !== expected.bytes) problems.push(`provenance.json records ${String(record.bytes)} bytes, but the package is ${expected.bytes}`);
  if (expected.entries !== undefined && record.entries !== expected.entries) problems.push(`provenance.json records ${String(record.entries)} entries, but the package has ${expected.entries}`);
  return problems;
}

/**
 * Zips `distDir`, writes the archive, its checksum file and `provenance.json` into `outDir`, and
 * verifies the result. Files are written even when verification fails so a failed run can be
 * inspected; callers decide on the exit code from `problems`.
 * @param {{ distDir: string, outDir: string, version: string, env?: NodeJS.ProcessEnv }} options
 */
export function buildPackage({ distDir, outDir, version, env = process.env }) {
  const dist = resolve(distDir);
  const out = resolve(outDir);
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error(`${dist} does not contain manifest.json; run "npm run build" first`);

  const zip = zipDirectory(dist);
  const sha256 = sha256Of(zip);
  const zipName = zipNameFor(version);
  const zipPath = join(out, zipName);
  mkdirSync(out, { recursive: true });
  writeFileSync(zipPath, zip);
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);

  const verification = verifyPackage(zip, { version });
  const provenance = buildProvenance({ zipName, version, sha256, bytes: zip.length, entries: verification.entries.length, env });
  writeFileSync(join(out, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

  return { zip, zipName, zipPath, sha256, provenance, problems: verification.problems, entries: verification.entries };
}

/**
 * Parses a `sha256sum`-style checksum file (`<hex>  <name>`).
 * @param {string} text
 * @returns {{ sha256: string, name: string } | null}
 */
export function parseChecksumFile(text) {
  const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/im.exec(text);
  return match ? { sha256: match[1].toLowerCase(), name: match[2] } : null;
}
