/**
 * Validates the Release workflow's dispatch inputs before any job with side effects runs.
 *
 *   node scripts/release/check-inputs.mjs --github-release true|false --store none|upload-only|submit-for-review|submit-staged \
 *     [--allow-non-monotonic true|false] [--reason "..."]
 *
 * Exit 1 with `::error::` lines when the combination is not allowed (a real release without a
 * store action, or a store action without a release). Writes `mode=dry-run|release` to
 * GITHUB_OUTPUT and the explanatory notes to the step summary.
 */
import { appendFileSync } from 'node:fs';
import { validateReleaseInputs } from './lib/inputs.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const result = validateReleaseInputs({
  githubRelease: option('github-release') ?? 'false',
  store: option('store') ?? '',
  allowNonMonotonic: option('allow-non-monotonic') ?? 'false',
  reason: option('reason') ?? '',
});

if (!result.ok) {
  for (const problem of result.problems) console.error(`::error::${problem}`);
  process.exit(1);
}

for (const note of result.notes) {
  console.log(note);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${note}\n`);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\n`);
