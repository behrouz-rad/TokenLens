/**
 * Asserts that a built manifest keeps the extension's security posture: Manifest V3, a DevTools
 * page only, no permissions, no host permissions, no background worker, no content scripts and no
 * relaxed content security policy. Run after `npm run build` and before any release.
 *
 *   node scripts/verify-manifest.mjs [path/to/manifest.json] [--expect-version X.Y.Z]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const versionFlag = args.indexOf('--expect-version');
const expectedVersion = versionFlag >= 0 ? args[versionFlag + 1] : null;
const manifestPath = resolve(args.find((a, i) => !a.startsWith('--') && i !== versionFlag + 1) ?? 'dist/manifest.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const problems = [];
const expect = (condition, message) => {
  if (!condition) problems.push(message);
};

expect(manifest.manifest_version === 3, 'manifest_version must be 3');
expect(manifest.name === 'TokenLens', 'name must be TokenLens');
expect(typeof manifest.devtools_page === 'string' && manifest.devtools_page.length > 0, 'devtools_page must be set');
expect(Array.isArray(manifest.permissions) && manifest.permissions.length === 0, 'permissions must be an empty array');
expect(manifest.host_permissions === undefined || manifest.host_permissions.length === 0, 'host_permissions must be absent');
expect(manifest.optional_permissions === undefined, 'optional_permissions must be absent');
expect(manifest.optional_host_permissions === undefined, 'optional_host_permissions must be absent');
expect(manifest.background === undefined, 'background must be absent');
expect(manifest.content_scripts === undefined, 'content_scripts must be absent');
expect(manifest.web_accessible_resources === undefined, 'web_accessible_resources must be absent');
expect(manifest.externally_connectable === undefined, 'externally_connectable must be absent');
expect(/^\d+(\.\d+){0,3}$/.test(String(manifest.version)), `version "${manifest.version}" is not a valid extension version`);
if (expectedVersion !== null) expect(manifest.version === expectedVersion, `version is ${manifest.version}, expected ${expectedVersion}`);

const csp = manifest.content_security_policy?.extension_pages ?? '';
expect(!/unsafe-eval|unsafe-inline|http:|https:/.test(csp), `content_security_policy must not relax script sources (got "${csp}")`);

if (problems.length > 0) {
  console.error(`Manifest check failed for ${manifestPath}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Manifest OK: ${manifestPath} (version ${manifest.version}, permissions: none)`);
