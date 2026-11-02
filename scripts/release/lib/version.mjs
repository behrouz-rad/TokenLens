/**
 * Release version rules shared by the prepare and check CLIs and their tests.
 *
 * A release version is `MAJOR.MINOR.PATCH` with no leading zeros and no `v` prefix. The sources
 * (`manifest.json`, `package.json`, `package-lock.json`) must already carry it so that the tag
 * created later points at a reviewed commit that builds exactly that version.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Files that record the version, in the order they are reported. */
export const VERSION_FILES = ['manifest.json', 'package.json', 'package-lock.json'];

/**
 * Compares two well-formed versions numerically; negative when `a` is lower than `b`.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Strips the `v` tag prefix so tags and versions compare alike.
 * @param {string} tagOrVersion
 * @returns {string}
 */
export function stripTagPrefix(tagOrVersion) {
  return tagOrVersion.trim().replace(/^v/, '');
}

/**
 * Splits a comma, space or newline separated tag list into bare versions.
 * @param {string | undefined} list
 * @returns {string[]}
 */
export function parseTagList(list) {
  return (list ?? '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(stripTagPrefix);
}

/**
 * Reads the version recorded in each source file of a checkout.
 * @param {string} rootDir
 * @returns {Record<string, string | undefined>} version per label
 */
export function readVersionSources(rootDir) {
  /** @param {string} file @returns {Record<string, any>} */
  const read = (file) => JSON.parse(readFileSync(join(rootDir, file), 'utf8'));
  const manifest = read('manifest.json');
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  return {
    'manifest.json': manifest.version,
    'package.json': pkg.version,
    'package-lock.json': lock.version,
    'package-lock.json (root package)': lock.packages?.['']?.version,
  };
}

/**
 * Writes `version` into every source file, preserving two-space JSON formatting.
 * @param {string} rootDir
 * @param {string} version
 * @returns {string[]} files written
 */
export function writeVersionSources(rootDir, version) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`"${version}" is not a valid release version (MAJOR.MINOR.PATCH)`);
  /** @param {string} file @param {(json: Record<string, any>) => void} mutate */
  const update = (file, mutate) => {
    const path = join(rootDir, file);
    /** @type {Record<string, any>} */
    const json = JSON.parse(readFileSync(path, 'utf8'));
    mutate(json);
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  };
  update('manifest.json', (m) => {
    m.version = version;
  });
  update('package.json', (p) => {
    p.version = version;
  });
  update('package-lock.json', (l) => {
    l.version = version;
    if (l.packages?.['']) l.packages[''].version = version;
  });
  return [...VERSION_FILES];
}

/**
 * @typedef {object} VersionCheckInput
 * @property {string} version requested release version
 * @property {Record<string, string | undefined>} sources versions found in the checkout, by label
 * @property {string} [latest] latest published release (tag or version), empty when none exists
 * @property {string[]} [existingTags] tags already present (with or without the `v` prefix)
 * @property {boolean} [allowNonMonotonic] turn the "not higher than latest" failure into a warning
 */

/**
 * Validates a requested release version against the checkout and the published history.
 * @param {VersionCheckInput} input
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
export function validateReleaseVersion({ version, sources, latest = '', existingTags = [], allowNonMonotonic = false }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];

  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    problems.push(`"${String(version)}" is not a valid release version; use MAJOR.MINOR.PATCH without a leading "v" or zero-padding`);
    return { ok: false, problems, warnings };
  }

  for (const [file, found] of Object.entries(sources)) {
    if (found !== version) {
      problems.push(`${file} is at ${found ?? 'an unknown version'}, expected ${version}. Run "npm run release:prepare -- ${version}" and merge the version bump first.`);
    }
  }

  const tags = existingTags.map(stripTagPrefix);
  if (tags.includes(version)) problems.push(`tag v${version} already exists`);

  const latestVersion = stripTagPrefix(latest ?? '');
  if (latestVersion) {
    if (!VERSION_PATTERN.test(latestVersion)) {
      warnings.push(`latest release "${latest}" is not a MAJOR.MINOR.PATCH version; monotonicity was not checked`);
    } else if (compareVersions(version, latestVersion) <= 0) {
      const message = `${version} is not higher than the latest release ${latestVersion}`;
      if (allowNonMonotonic) warnings.push(`${message}; allowed by explicit override`);
      else problems.push(`${message}; pick a higher version or re-run with the non-monotonic override and a reason`);
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}
