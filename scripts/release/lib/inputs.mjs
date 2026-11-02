/**
 * Rules for the manual workflow inputs, shared by the Release and Retry workflows and their tests.
 *
 * A real release (git tag plus GitHub Release) must always schedule the same package for the
 * Chrome Web Store, so a published version can never exist without a store upload or submission
 * being attempted. The only way to skip the store is the dry run, which publishes nothing at all.
 * Uploading a draft, submitting for review, staging and public availability remain distinct.
 */

/** Workflow input values for the store step, in the order the dispatch form offers them. */
export const STORE_INPUTS = /** @type {const} */ (['none', 'upload-only', 'submit-for-review', 'submit-staged']);

/** Store inputs that actually touch the Chrome Web Store. */
export const STORE_ACTION_INPUTS = /** @type {const} */ (['upload-only', 'submit-for-review', 'submit-staged']);

/**
 * @typedef {object} ReleaseInputs
 * @property {boolean | string} githubRelease `github_release` input (booleans arrive as strings in shell steps)
 * @property {string} store `store` input
 * @property {boolean | string} [allowNonMonotonic] `allow_non_monotonic` input
 * @property {string} [reason] `reason` input
 */

/** @param {boolean | string | undefined} value */
export function parseWorkflowBoolean(value) {
  if (typeof value === 'boolean') return value;
  return String(value ?? '').trim().toLowerCase() === 'true';
}

/**
 * Validates the Release workflow inputs before anything else runs.
 * @param {ReleaseInputs} inputs
 * @returns {{ ok: boolean, mode: 'dry-run' | 'release' | 'invalid', problems: string[], notes: string[] }}
 */
export function validateReleaseInputs(inputs) {
  const githubRelease = parseWorkflowBoolean(inputs.githubRelease);
  const allowNonMonotonic = parseWorkflowBoolean(inputs.allowNonMonotonic);
  const store = String(inputs.store ?? '').trim();
  const reason = String(inputs.reason ?? '').trim();
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];

  if (!STORE_INPUTS.includes(/** @type {any} */ (store))) {
    problems.push(`unknown store action "${store}"; use one of ${STORE_INPUTS.join(', ')}`);
  } else if (githubRelease && store === 'none') {
    problems.push('a real release must schedule the Chrome Web Store step: choose upload-only, submit-for-review or submit-staged, or turn github_release off for a dry run');
  } else if (!githubRelease && store !== 'none') {
    problems.push(`store=${store} requires github_release=true so the uploaded package is traceable to a GitHub Release; a dry run uses store=none`);
  }

  if (allowNonMonotonic && !reason) problems.push('allow_non_monotonic needs a reason');
  if (allowNonMonotonic && reason) notes.push(`Non-monotonic version override requested: ${reason}`);

  const mode = problems.length > 0 ? 'invalid' : githubRelease ? 'release' : 'dry-run';
  if (mode === 'dry-run') notes.push('Dry run: validate, test and package only; nothing is tagged, released or uploaded.');
  if (mode === 'release') {
    notes.push(
      store === 'upload-only'
        ? 'Release with a Chrome Web Store draft upload; the draft is submitted by hand from the Developer Dashboard.'
        : store === 'submit-staged'
          ? 'Release with a staged Chrome Web Store submission; after approval it waits in the Developer Dashboard until published by hand.'
          : 'Release with a Chrome Web Store submission for review; it goes live only when Google approves it.'
    );
  }
  return { ok: problems.length === 0, mode, problems, notes };
}
