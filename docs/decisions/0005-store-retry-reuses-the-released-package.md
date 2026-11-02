# ADR 0005: A real release always schedules the store, and store retries reuse the released package

- Status: Accepted
- Scope: `.github/workflows/release.yml`, `.github/workflows/retry-store.yml`, `scripts/release/lib/inputs.mjs`, `scripts/release/lib/github-release.mjs`, `scripts/release/lib/cws.mjs`, `docs/release.md`

## Context

ADR 0004 made releases manual and separated the GitHub Release from the Chrome Web Store
submission. Two gaps remained.

First, the Release workflow accepted `github_release=true` with `store=none`, so a version could
be tagged and published on GitHub without the same package ever being scheduled for the store.
The product is distributed through the store; a GitHub-only release is an inconsistency, not an
option.

Second, the two publishing steps are not a transaction. The GitHub Release is created before the
store call, and when the store upload or submission then fails (expired token, quota, store
outage, incomplete listing) the release cannot be re-run: the tag already exists and the version
check rejects it by design. Recovery meant hand-uploading a locally rebuilt ZIP, which breaks the
single-build guarantee.

The Chrome Web Store API v2 constrains the recovery. `fetchStatus` reports the versions of the
published and the submitted revision and whether an upload happened in the last 24 hours, but
nothing about an unsubmitted draft: not its version, not its hash. A draft of the right version
number therefore cannot be proven to be the released bytes.

## Alternatives

- Make the Release workflow skip the version check when the tag exists and rebuild: a second
  build may differ from the released one, and the tag would no longer prove what was tested.
- Submit an existing draft when its version matches: equates a version number with package
  identity, which the API cannot support, and risks publishing bytes nobody verified.
- Create the store submission before the GitHub Release: store review takes days and may fail,
  leaving the version in the store without the auditable release that explains it.
- Keep `store=none` with a release as a "GitHub-only" mode: there is no such product.

## Decision

1. The Release workflow validates its inputs with one shared rule set
   (`scripts/release/lib/inputs.mjs`): `github_release=false, store=none` is the dry run;
   `github_release=true` requires `upload-only`, `submit-for-review` or `submit-staged`; every other
   combination fails before any job with side effects. Uploading a draft, submitting for review,
   staging and public availability stay distinct, and none of them is described as "published".
2. A separate manual workflow, *Retry Chrome Web Store*, resumes the store step of an existing
   release. It takes the version, the store action and an explicit `replace_draft` acknowledgement.
   It never builds, tags, bumps a version or creates a release, and it shares the Release
   workflow's concurrency group so the store is never touched by two runs at once.
3. The GitHub Release is the source of truth. The retry downloads `TokenLens-vX.Y.Z.zip`, its
   `.sha256` and `provenance.json` from the release for tag `vX.Y.Z`, verifies the checksum, the
   package structure and manifest version (the same `verifyPackage` the Release workflow uses) and
   the provenance schema and consistency, and only then talks to the store. The store job verifies
   the artifact again before authenticating.
4. The store is inspected before any mutation and the policy is conservative:
   - the version already published, pending review or staged: report, change nothing;
   - another version submitted, a higher version published, a rejected submission, a taken-down
     item, or a response the client cannot interpret: fail with instructions, change nothing;
   - an earlier upload still processing: wait with bounded polling;
   - otherwise the verified release package is uploaded, which replaces whatever draft exists,
     and then submitted if asked. Because the API cannot show what a draft contains, this upload
     happens only with `replace_draft` on; without it the run fails before touching the store.
5. Authentication, state inspection, upload, submission, retry and reporting are separate,
   injectable functions in `scripts/release/lib/cws.mjs` and `lib/github-release.mjs`, tested
   against scripted responses and a local HTTP server; nothing in the test suite reaches GitHub or
   the store.

## Consequences

- A version with a GitHub Release always has a store upload or submission attempt recorded in the
  same run or in a retry run; a store submission without a GitHub Release remains impossible.
- Retries are safe to repeat but are not idempotent in the strict sense: when the store shows no
  submission for the version, every retry re-uploads the same verified bytes and replaces the
  draft. Submissions are never duplicated because the submitted revision's version is checked
  first.
- Error reports say whether re-running later is sensible (`retry_safe`) or a person has to act in
  the Developer Dashboard. Acceptance of a submission is reported as acceptance, never as
  approval or availability.
- The 24-hour window of `lastAsyncUploadState` and the absence of draft metadata are documented
  limitations; operators are told to look at the dashboard whenever the run refuses to guess.
- Branch and actor restrictions, least-privilege permissions (`contents: read`, `id-token: write`
  only in the store job), Workload Identity Federation and the environment variables are the same
  as in ADR 0004.
