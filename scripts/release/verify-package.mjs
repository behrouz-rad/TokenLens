/**
 * Verifies a release ZIP produced by package.mjs, independently of the job that built it.
 *
 *   node scripts/release/verify-package.mjs --zip release/TokenLens-v1.0.0.zip --version 1.0.0 \
 *     [--sha256 <hex> | --checksum release/TokenLens-v1.0.0.zip.sha256] [--dist dist]
 *
 * Checks the checksum against the recorded value, re-runs the structural verification (manifest
 * at the root, expected version, minimal permissions, no development files or fixture content)
 * and, with --dist, that the archive holds exactly the files of that directory. The release
 * workflow runs this before Playwright so the tested build is provably the packaged build.
 */
import { readFileSync } from 'node:fs';
import { VERSION_PATTERN } from './lib/version.mjs';
import { parseChecksumFile, sha256Of, verifyPackage, verifyPackageMatchesDist } from './lib/package.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const zipPath = option('zip');
const version = option('version');
if (!zipPath || !version || !VERSION_PATTERN.test(version)) {
  console.error('usage: node scripts/release/verify-package.mjs --zip <file> --version X.Y.Z [--sha256 <hex> | --checksum <file>] [--dist <dir>]');
  process.exit(2);
}

const problems = [];
let zip;
try {
  zip = readFileSync(zipPath);
} catch (error) {
  console.error(`cannot read ${zipPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const actual = sha256Of(zip);
let expected = option('sha256')?.toLowerCase();
const checksumFile = option('checksum');
if (checksumFile) {
  const parsed = parseChecksumFile(readFileSync(checksumFile, 'utf8'));
  if (!parsed) problems.push(`${checksumFile} is not a sha256sum checksum file`);
  else if (expected && expected !== parsed.sha256) problems.push(`--sha256 (${expected}) disagrees with ${checksumFile} (${parsed.sha256})`);
  else expected = parsed.sha256;
}
if (expected && expected !== actual) problems.push(`SHA-256 mismatch: archive is ${actual}, expected ${expected}`);

const verification = verifyPackage(zip, { version });
problems.push(...verification.problems);

const distDir = option('dist');
if (distDir) problems.push(...verifyPackageMatchesDist(zip, distDir));

if (problems.length > 0) {
  console.error(`Package verification failed for ${zipPath}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Verified ${zipPath}: SHA-256 ${actual}, ${verification.entries.length} files, manifest version ${version}${distDir ? `, identical to ${distDir}` : ''}`);
