/**
 * Packages the built extension into a reproducible, verified release ZIP.
 *
 *   node scripts/release/package.mjs --version 1.0.0 [--dist dist] [--out release]
 *
 * Produces `<out>/TokenLens-v<version>.zip`, `<out>/TokenLens-v<version>.zip.sha256` and
 * `<out>/provenance.json`, then re-opens the archive and checks that manifest.json sits at its
 * root with the expected version, that nothing from the development tree slipped in, and that
 * the bundle does not contain development-only data.
 */
import { writeFileSync } from 'node:fs';
import { VERSION_PATTERN } from './lib/version.mjs';
import { buildPackage } from './lib/package.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const version = option('version');

if (!version || !VERSION_PATTERN.test(version)) {
  console.error('usage: node scripts/release/package.mjs --version X.Y.Z [--dist dist] [--out release]');
  process.exit(2);
}

let result;
try {
  result = buildPackage({ distDir: option('dist', 'dist'), outDir: option('out', 'release'), version });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (result.problems.length > 0) {
  console.error(`Package verification failed for ${result.zipName}:`);
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Packaged ${result.zipName} (${result.entries.length} files, ${result.zip.length} bytes)`);
console.log(`SHA-256 ${result.sha256}`);
for (const entry of result.entries) console.log(`  ${entry}`);

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `zip=${result.zipPath}\nzip_name=${result.zipName}\nsha256=${result.sha256}\n`, { flag: 'a' });
}
