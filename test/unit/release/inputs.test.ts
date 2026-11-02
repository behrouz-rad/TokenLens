import { describe, expect, it } from 'vitest';
import { parseWorkflowBoolean, STORE_ACTION_INPUTS, STORE_INPUTS, validateReleaseInputs } from '../../../scripts/release/lib/inputs.mjs';

/**
 * A real release must always schedule the Chrome Web Store step; only the dry run may skip it.
 * The six input combinations of the Release workflow are pinned here.
 */
describe('validateReleaseInputs', () => {
  it('accepts the dry run: github_release=false with store=none', () => {
    const result = validateReleaseInputs({ githubRelease: false, store: 'none' });
    expect(result).toMatchObject({ ok: true, mode: 'dry-run', problems: [] });
    expect(result.notes.join(' ')).toMatch(/nothing is tagged, released or uploaded/);
  });

  it('rejects a store action without a GitHub Release', () => {
    for (const store of STORE_ACTION_INPUTS) {
      const result = validateReleaseInputs({ githubRelease: false, store });
      expect(result.ok).toBe(false);
      expect(result.mode).toBe('invalid');
      expect(result.problems).toEqual([expect.stringMatching(new RegExp(`store=${store} requires github_release=true`))]);
    }
  });

  it('rejects a GitHub Release that skips the store', () => {
    const result = validateReleaseInputs({ githubRelease: true, store: 'none' });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringMatching(/real release must schedule the Chrome Web Store step/)]);
  });

  it('accepts every store action together with a GitHub Release and describes it without overclaiming', () => {
    for (const store of STORE_ACTION_INPUTS) {
      const result = validateReleaseInputs({ githubRelease: true, store });
      expect(result).toMatchObject({ ok: true, mode: 'release', problems: [] });
      const note = result.notes.join(' ');
      expect(note).not.toMatch(/publicly available|is published|now live/);
    }
    expect(validateReleaseInputs({ githubRelease: true, store: 'upload-only' }).notes.join(' ')).toMatch(/draft upload.*submitted by hand/);
    expect(validateReleaseInputs({ githubRelease: true, store: 'submit-for-review' }).notes.join(' ')).toMatch(/goes live only when Google approves/);
    expect(validateReleaseInputs({ githubRelease: true, store: 'submit-staged' }).notes.join(' ')).toMatch(/staged.*until published by hand/);
  });

  it('rejects unknown store values instead of treating them as a dry run', () => {
    const result = validateReleaseInputs({ githubRelease: false, store: 'publish-now' });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/unknown store action "publish-now"; use one of none, upload-only, submit-for-review, submit-staged/);
    expect(validateReleaseInputs({ githubRelease: true, store: '' }).ok).toBe(false);
  });

  it('requires a reason for the non-monotonic override and records it', () => {
    expect(validateReleaseInputs({ githubRelease: false, store: 'none', allowNonMonotonic: true }).problems).toEqual(['allow_non_monotonic needs a reason']);
    const result = validateReleaseInputs({ githubRelease: false, store: 'none', allowNonMonotonic: 'true', reason: 'hotfix re-release' });
    expect(result.ok).toBe(true);
    expect(result.notes[0]).toBe('Non-monotonic version override requested: hotfix re-release');
  });

  it('reads workflow booleans the way shell steps receive them', () => {
    expect(parseWorkflowBoolean(true)).toBe(true);
    expect(parseWorkflowBoolean('true')).toBe(true);
    expect(parseWorkflowBoolean(' TRUE ')).toBe(true);
    expect(parseWorkflowBoolean('false')).toBe(false);
    expect(parseWorkflowBoolean('')).toBe(false);
    expect(parseWorkflowBoolean(undefined)).toBe(false);
    expect(parseWorkflowBoolean('yes')).toBe(false);
  });

  it('keeps the dispatch choices in sync', () => {
    expect([...STORE_INPUTS]).toEqual(['none', ...STORE_ACTION_INPUTS]);
  });
});
