/**
 * Sets the release version in every file that records it, so a single version-bump commit can be
 * reviewed, merged into main and then released by the Release workflow.
 *
 *   node scripts/release/prepare.mjs 1.0.0
 */
import { VERSION_PATTERN, writeVersionSources } from './lib/version.mjs';

const version = process.argv[2] ?? '';
if (!VERSION_PATTERN.test(version)) {
  console.error('usage: node scripts/release/prepare.mjs MAJOR.MINOR.PATCH');
  process.exit(2);
}

const files = writeVersionSources(process.cwd(), version);
console.log(`Version set to ${version} in ${files.join(', ')}`);
