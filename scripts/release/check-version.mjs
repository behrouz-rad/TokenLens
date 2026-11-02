/**
 * Validates a requested release version against the repository and the published history.
 *
 *   node scripts/release/check-version.mjs --version 1.0.0 [--latest v0.9.0] [--existing-tags "v0.1.0,v0.2.0"] [--allow-non-monotonic]
 *
 * Fails when the version is malformed, differs from manifest.json / package.json /
 * package-lock.json (the sources must already carry the release version so the tag points at a
 * reproducible commit), already has a tag, or is not higher than the latest release.
 */
import { writeFileSync } from 'node:fs';
import { parseTagList, readVersionSources, validateReleaseVersion } from './lib/version.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const version = option('version') ?? '';
const latest = option('latest') ?? '';
const result = validateReleaseVersion({
  version,
  sources: readVersionSources(process.cwd()),
  latest,
  existingTags: parseTagList(option('existing-tags')),
  allowNonMonotonic: args.includes('--allow-non-monotonic'),
});

for (const warning of result.warnings) console.warn(`::warning::${warning}`);
if (!result.ok) {
  for (const problem of result.problems) console.error(`::error::${problem}`);
  process.exit(1);
}

console.log(`Version ${version} is valid${latest ? ` (latest release: ${latest})` : ''}`);
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`, { flag: 'a' });
