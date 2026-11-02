import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions,
  parseTagList,
  readVersionSources,
  stripTagPrefix,
  validateReleaseVersion,
  VERSION_PATTERN,
  writeVersionSources,
} from '../../../scripts/release/lib/version.mjs';

const sources = (version: string) => ({
  'manifest.json': version,
  'package.json': version,
  'package-lock.json': version,
  'package-lock.json (root package)': version,
});

describe('VERSION_PATTERN', () => {
  it.each(['0.0.0', '0.1.0', '1.0.0', '10.20.30', '1.0.10'])('accepts %s', (version) => {
    expect(VERSION_PATTERN.test(version)).toBe(true);
  });

  it.each(['', 'v1.0.0', '1.0', '1', '1.0.0.0', '01.0.0', '1.02.0', '1.0.03', '1.0.0-beta', '1.0.0+build', ' 1.0.0', '1.0.0\n', 'a.b.c', '1..0'])('rejects %j', (version) => {
    expect(VERSION_PATTERN.test(version)).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
  });

  it('is antisymmetric across a sample of versions', () => {
    const versions = ['0.0.1', '0.1.0', '0.1.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0'];
    for (let i = 0; i < versions.length; i++) {
      for (let j = 0; j < versions.length; j++) {
        expect(Math.sign(compareVersions(versions[i]!, versions[j]!))).toBe(Math.sign(j - i) * -1 * -1 === 0 ? 0 : Math.sign(i - j));
      }
    }
  });
});

describe('tag helpers', () => {
  it('strips the v prefix and splits tag lists on commas, spaces and newlines', () => {
    expect(stripTagPrefix('v1.2.3')).toBe('1.2.3');
    expect(stripTagPrefix(' 1.2.3 ')).toBe('1.2.3');
    expect(parseTagList('v0.1.0,v0.2.0, v0.3.0\nv1.0.0,,')).toEqual(['0.1.0', '0.2.0', '0.3.0', '1.0.0']);
    expect(parseTagList(undefined)).toEqual([]);
    expect(parseTagList('')).toEqual([]);
  });
});

describe('validateReleaseVersion', () => {
  it('accepts a well-formed version that matches every source and is higher than the latest release', () => {
    const result = validateReleaseVersion({ version: '1.0.0', sources: sources('1.0.0'), latest: 'v0.9.0', existingTags: ['v0.8.0', 'v0.9.0'] });
    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('accepts the first release when no latest release exists', () => {
    expect(validateReleaseVersion({ version: '0.1.0', sources: sources('0.1.0'), latest: '', existingTags: [] }).ok).toBe(true);
    expect(validateReleaseVersion({ version: '0.1.0', sources: sources('0.1.0') }).ok).toBe(true);
  });

  it.each(['', 'v1.0.0', '1.0', '01.0.0', '1.0.0-rc.1', '1.0.0.0'])('rejects malformed version %j before looking at the sources', (version) => {
    const result = validateReleaseVersion({ version, sources: sources('9.9.9') });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/not a valid release version/);
  });

  it('rejects non-string input', () => {
    const result = validateReleaseVersion({ version: undefined as unknown as string, sources: sources('1.0.0') });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/not a valid release version/);
  });

  it('reports every source file that disagrees, naming the file and the fix', () => {
    const result = validateReleaseVersion({
      version: '1.0.0',
      sources: { 'manifest.json': '1.0.0', 'package.json': '0.9.0', 'package-lock.json': '0.9.0', 'package-lock.json (root package)': undefined },
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.stringMatching(/^package\.json is at 0\.9\.0, expected 1\.0\.0\. Run "npm run release:prepare -- 1\.0\.0"/),
      expect.stringMatching(/^package-lock\.json is at 0\.9\.0, expected 1\.0\.0/),
      expect.stringMatching(/^package-lock\.json \(root package\) is at an unknown version, expected 1\.0\.0/),
    ]);
  });

  it('rejects a version whose tag already exists, with or without the v prefix', () => {
    expect(validateReleaseVersion({ version: '1.0.0', sources: sources('1.0.0'), existingTags: ['v1.0.0'] }).problems).toEqual(['tag v1.0.0 already exists']);
    expect(validateReleaseVersion({ version: '1.0.0', sources: sources('1.0.0'), existingTags: ['1.0.0'] }).problems).toEqual(['tag v1.0.0 already exists']);
  });

  it('rejects a version equal to the latest release', () => {
    const result = validateReleaseVersion({ version: '1.0.0', sources: sources('1.0.0'), latest: 'v1.0.0' });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringMatching(/^1\.0\.0 is not higher than the latest release 1\.0\.0; pick a higher version/)]);
  });

  it('rejects a version lower than the latest release', () => {
    const result = validateReleaseVersion({ version: '1.0.9', sources: sources('1.0.9'), latest: '1.0.10' });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/1\.0\.9 is not higher than the latest release 1\.0\.10/);
  });

  it('turns a non-monotonic version into a warning only with the explicit override', () => {
    const result = validateReleaseVersion({ version: '0.9.0', sources: sources('0.9.0'), latest: 'v1.0.0', allowNonMonotonic: true });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual(['0.9.0 is not higher than the latest release 1.0.0; allowed by explicit override']);
  });

  it('does not let the override hide other problems', () => {
    const result = validateReleaseVersion({ version: '0.9.0', sources: sources('0.9.0'), latest: 'v1.0.0', existingTags: ['v0.9.0'], allowNonMonotonic: true });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['tag v0.9.0 already exists']);
  });

  it('warns instead of guessing when the latest release tag is not a plain version', () => {
    const result = validateReleaseVersion({ version: '1.0.0', sources: sources('1.0.0'), latest: 'nightly-2024' });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.stringMatching(/monotonicity was not checked/)]);
  });

  it('collects all problems at once so a single run reports everything', () => {
    const result = validateReleaseVersion({ version: '1.0.0', sources: { 'manifest.json': '0.9.0' }, latest: 'v1.0.0', existingTags: ['v1.0.0'] });
    expect(result.problems).toHaveLength(3);
  });
});

describe('version sources on disk', () => {
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenlens-version-'));
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ manifest_version: 3, name: 'TokenLens', version: '0.1.0' }, null, 2)}\n`);
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'tokenlens', version: '0.1.0' }, null, 2)}\n`);
    writeFileSync(
      join(dir, 'package-lock.json'),
      `${JSON.stringify({ name: 'tokenlens', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'tokenlens', version: '0.1.0' }, 'node_modules/x': { version: '1.0.0' } } }, null, 2)}\n`
    );
    return dir;
  };

  it('reads the four recorded versions', () => {
    const dir = fixture();
    try {
      expect(readVersionSources(dir)).toEqual(sources('0.1.0'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the version into every file, keeps formatting and leaves other packages alone', () => {
    const dir = fixture();
    try {
      expect(writeVersionSources(dir, '1.2.3')).toEqual(['manifest.json', 'package.json', 'package-lock.json']);
      expect(readVersionSources(dir)).toEqual(sources('1.2.3'));
      const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
      expect(lock.packages['node_modules/x'].version).toBe('1.0.0');
      expect(lock.lockfileVersion).toBe(3);
      for (const file of ['manifest.json', 'package.json', 'package-lock.json']) {
        const text = readFileSync(join(dir, file), 'utf8');
        expect(text.endsWith('}\n')).toBe(true);
        expect(text).toContain('\n  "');
      }
      expect(validateReleaseVersion({ version: '1.2.3', sources: readVersionSources(dir) }).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write a malformed version and touches nothing', () => {
    const dir = fixture();
    try {
      expect(() => writeVersionSources(dir, 'v1.2.3')).toThrow(/not a valid release version/);
      expect(readVersionSources(dir)).toEqual(sources('0.1.0'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
