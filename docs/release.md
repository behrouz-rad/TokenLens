# Releasing TokenLens

Releases are started by hand from the GitHub Actions tab. Pushes, merges and tags never publish
anything. The pipeline validates the requested version, runs every quality gate, packages one
reproducible ZIP, and only then (if asked) creates the GitHub Release and uploads or submits that
same ZIP to the Chrome Web Store. Decision records: `docs/decisions/0004-manual-release-and-store-publishing.md`
and `docs/decisions/0005-store-retry-reuses-the-released-package.md`.

## Versioning

- Versions are `MAJOR.MINOR.PATCH` (for example `0.2.0`, `1.0.0`, `1.0.1`); tags are `vMAJOR.MINOR.PATCH`.
- `manifest.json`, `package.json`, `package-lock.json`, the toolbar badge, the artifact name, the
  tag and the GitHub Release all carry the same version. The badge is injected at build time from
  `manifest.json`; a unit test keeps `manifest.json` and `package.json` equal.
- A release version must be higher than the latest GitHub Release. Re-releasing or releasing a
  lower version needs the `allow_non_monotonic` input and a written reason, both recorded in the
  run summary.
- The version must already be on `main` before releasing, so that the tag points at a reviewed
  commit. Use the *Prepare release* workflow (or `npm run release:prepare -- X.Y.Z` locally) and
  merge the pull request it opens.

## Procedure

1. **Prepare the version.** Actions → *Prepare release* → *Run workflow* → enter the version. A
   pull request `release/vX.Y.Z` is opened with the three version bumps. GitHub does not start
   workflows for events created with the workflow's own token, so CI does not run on that pull
   request by itself: close and reopen it, or push an empty commit to its branch, and CI runs.
   Review and merge it once CI is green.
2. **Rehearse (recommended).** Actions → *Release* → *Run workflow* with the version,
   `github_release` unticked and `store` = `none`. The run validates the version, runs typecheck,
   lint, unit and component tests, builds, packages and verifies the ZIP, proves that the build
   Playwright tests is file-for-file the ZIP's content, runs the Playwright projects, and uploads
   the package as the `TokenLens-vX.Y.Z` artifact (ZIP, `.sha256`, `provenance.json`). Nothing is
   tagged or published. Download the artifact, check `sha256sum -c`, unzip it and load the folder
   with *Load unpacked* at least once before the real release.
3. **Run the real DevTools acceptance test locally** (`npm run test:e2e:devtools`, headed) and
   look at `e2e/.artifacts/*.png`. The hosted runners cannot drive a real DevTools window.
4. **Release.** Run *Release* again with `github_release` ticked and a `store` action chosen. If
   the `release` environment has required reviewers, approve the deployment when prompted. The job
   re-verifies the checksum, creates tag `vX.Y.Z` on the tested commit and publishes a GitHub
   Release with `TokenLens-vX.Y.Z.zip`, `TokenLens-vX.Y.Z.zip.sha256`, `provenance.json` and
   generated notes.
5. **Chrome Web Store (always part of a real release).** The `chrome-web-store` job uses the ZIP
   attached to the release:
   - `upload-only`: upload a new draft; nothing is submitted. Review and submit in the dashboard.
   - `submit-for-review`: upload and call `publish` with `DEFAULT_PUBLISH`. Google reviews the
     submission and publishes it automatically on approval.
   - `submit-staged`: upload and call `publish` with `STAGED_PUBLISH`. After approval the release
     waits until it is published from the dashboard.
   Submission is not availability: review time and outcome belong to Google and are reported in
   the job summary from the API's response. If this job fails after the GitHub Release exists,
   resume it with the *Retry Chrome Web Store* workflow (below); re-running *Release* is refused
   because the tag exists.

Inputs are validated before anything runs: a non-`main` ref, an unauthorised actor, a malformed or
already released version, or a disallowed input combination fails immediately. The allowed
combinations are:

| `github_release` | `store` | Result |
| --- | --- | --- |
| off | `none` | Dry run: validate, test and package; nothing is tagged, released or uploaded |
| off | any action | Rejected: a store upload must be traceable to a GitHub Release |
| on | `none` | Rejected: a real release always schedules the store step |
| on | `upload-only`, `submit-for-review`, `submit-staged` | Release plus that store action |

A dry run is the only way to skip the store. Choosing `upload-only` does not make the extension
available: the draft still has to be submitted and approved.

## What the pipeline guarantees

- One build. `dist/` is built once, zipped once, and the E2E job proves with
  `scripts/release/verify-package.mjs` that the `dist/` it tests is exactly the ZIP's content with
  the recorded SHA-256. Every publishing job re-checks that checksum before using the ZIP.
- Workflow inputs reach shell steps only through environment variables, so a crafted input cannot
  become shell syntax.
- The ZIP is deterministic (sorted entries, fixed timestamps) and verified: `manifest.json` at the
  root with the requested version, no permissions, no background worker, no development files,
  no mock data, no JWT-shaped or key-shaped content.
- Secrets never reach logs. The store token is short-lived, scoped to
  `https://www.googleapis.com/auth/chromewebstore`, passed through an environment variable, and
  not written to disk.
- Concurrency is limited to one release at a time and runs are never cancelled half-way; the
  *Retry Chrome Web Store* workflow shares the same group, so the store is never changed by two
  runs at once.
- A version with a GitHub Release always has a store upload or submission attempt, in the same run
  or in a retry; a store submission without a GitHub Release is impossible.

## Retrying the Chrome Web Store step

The GitHub Release and the store submission are not a transaction. When the `chrome-web-store`
job fails after the release exists (expired token, quota, store outage, incomplete listing),
resume it from the Actions tab: *Retry Chrome Web Store* → *Run workflow* on `main`.

Inputs:

| Input | Meaning |
| --- | --- |
| `version` | the released version, e.g. `1.0.0`; tag `v1.0.0` and its GitHub Release must exist |
| `store` | `upload-only`, `submit-for-review` or `submit-staged`, with the meanings above |
| `replace_draft` | permission to upload the released package, which replaces any unsubmitted draft in the Developer Dashboard. Off: the run only reports when the version is already submitted or published and otherwise stops before touching the store |

What the run does, in order:

1. Checks the branch, the actor and the inputs, exactly like *Release*.
2. Downloads `TokenLens-vX.Y.Z.zip`, its `.sha256` and `provenance.json` from the GitHub Release for
   tag `vX.Y.Z` (`scripts/release/fetch-release.mjs`). A missing release, a draft release or missing
   assets stop the run: only a package published by *Release* can be retried, and nothing is ever
   rebuilt.
3. Verifies the checksum, the package structure and manifest version with the same code the
   Release workflow uses, and the provenance file's schema and agreement with the package. The
   verified files are kept as the `TokenLens-vX.Y.Z-released` artifact and verified once more in
   the store job before authentication.
4. Reads the item's state with `fetchStatus` and decides:

   | Store reports | Outcome | Store changed? |
   | --- | --- | --- |
   | version published (`PUBLISHED`, `PUBLISHED_TO_TESTERS`) | `published`: run succeeds | no |
   | version submitted and `PENDING_REVIEW` | `in-review`: run succeeds | no |
   | version submitted and `STAGED` | `staged`: publish it from the dashboard | no |
   | an earlier upload still `IN_PROGRESS` | waits with bounded polling, then re-decides | no |
   | another version submitted; a higher version published; submission `REJECTED`; item taken down; a response the client cannot interpret | fails with instructions | no |
   | none of the above (no record, last upload `SUCCEEDED` but not submitted, `FAILED`, `NOT_FOUND`, or `CANCELLED`) | uploads the released package, then submits if asked | yes, with `replace_draft` on; otherwise fails first |

5. Reports one of `uploaded`, `submitted`, `in-review`, `staged`, `published` (job output
   `outcome`) or fails with `retry_safe=true` (rate limit, server error, network failure, upload
   still processing: re-run later) or `retry_safe=false` (a person has to look at the Developer
   Dashboard first). "Submitted" means Google accepted the submission for review, not that the
   extension was approved or is available.

Limitations, by design:

- The API does not expose an unsubmitted draft's version or content, and `lastAsyncUploadState`
  covers only the last 24 hours. The retry therefore never submits an existing draft on the
  strength of its version number; it re-uploads the verified release bytes instead. Repeating a
  retry whose version is not yet submitted re-uploads the same bytes again; it never submits twice.
- A draft of a different version that someone uploaded by hand is replaced when `replace_draft`
  is on. Check the dashboard before enabling it if such a draft may exist.
- The retry uses the same `chrome-web-store` environment, variables, Workload Identity Federation
  setup and `RELEASE_PUBLISHERS` rule as *Release*; its permissions are `contents: read` plus
  `id-token: write` in the store job only.

## One-time setup (repository owner)

Everything below is owner-managed. Placeholders are in angle brackets; none of them is known to
the repository.

### GitHub

- Branch protection (or a ruleset) on `main` with the CI checks required. GitHub offers this on
  public repositories and on paid plans; a private repository on the free plan has no branch
  protection, so merging to `main` is then controlled only by who has write access.
- Environment `release`: create it under *Settings → Environments* and add required reviewers to
  gate the GitHub Release. A workflow that references an environment which does not exist creates
  it without any protection rule, so the environment must exist with its reviewers before the
  first real release.
- Environment `chrome-web-store`: create it, add required reviewers (recommended) and the
  variables below. The same caveat applies.
- Repository variable `RELEASE_PUBLISHERS` (optional): comma-separated GitHub logins allowed to
  run releases besides the repository owner. The owner check uses the GitHub login that started
  the workflow; it is a convenience, not a substitute for the environment reviewers above.

### Chrome Web Store

1. Register a [Chrome Web Store developer account](https://chrome.google.com/webstore/devconsole),
   pay the one-time fee, complete developer verification and enable 2-step verification on the
   Google account (required by the API for publishing).
2. Create the item once by uploading a ZIP through the dashboard (the API cannot create items).
   Record the 32-character extension id as `<CWS_EXTENSION_ID>`.
3. Fill in the **Store listing** (name, description, screenshots, category) and **Privacy** tabs
   (single purpose, permission justification, data-use disclosures: TokenLens collects no data,
   makes no network requests and requests no permissions). Publishing is impossible until these
   are complete. The listing text, 1280×800 screenshots and promo tiles live in `docs/store/`;
   the privacy policy is `PRIVACY.md`, which the store requires even though all processing is
   local, and its URL must be publicly reachable when the item is submitted. The disclosure
   checkboxes and the three certifications are the publisher's own attestations and are ticked
   by hand.
4. Find the publisher id under **Publisher → Settings**; record it as `<CWS_PUBLISHER_ID>`.

### Google Cloud (keyless authentication)

1. Create or pick a Google Cloud project and enable the **Chrome Web Store API**.
2. Create a service account `<CWS_SERVICE_ACCOUNT>` (for example
   `tokenlens-publisher@<project>.iam.gserviceaccount.com`). It needs no project IAM roles.
3. Add that service account's email as a member of the publisher in the Chrome Web Store
   Developer Dashboard (**Account** section). The store allows one service account per publisher.
4. Create a Workload Identity Pool and an OIDC provider for GitHub (`https://token.actions.githubusercontent.com`)
   with an attribute condition restricting it to this repository, for example
   `assertion.repository == "<owner>/TokenLens"`.
5. Grant the pool principal set for the repository `roles/iam.workloadIdentityUser` on the
   service account.
6. Record the provider resource name as `<GCP_WORKLOAD_IDENTITY_PROVIDER>`
   (`projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`).

### Environment variables for `chrome-web-store`

| Variable | Value |
| --- | --- |
| `CWS_PUBLISHER_ID` | `<CWS_PUBLISHER_ID>` from Publisher → Settings |
| `CWS_EXTENSION_ID` | `<CWS_EXTENSION_ID>` of the dashboard-created item |
| `CWS_SERVICE_ACCOUNT` | `<CWS_SERVICE_ACCOUNT>` email |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `<GCP_WORKLOAD_IDENTITY_PROVIDER>` resource name |

No secret is required. If a key file must be used instead (not recommended), do not add it to this
repository's workflow without a decision record; the job is written to fail clearly when the
variables above are missing.

## First submission

The first store submission typically needs more than the API provides: listing assets, privacy
disclosures, possibly a review questionnaire, and the developer verification above. Run the
pipeline with `store` = `upload-only` the first time, finish the listing in the dashboard, and
submit from there. Later releases can use `submit-for-review` or `submit-staged`.

## Local dry run

The scripts the workflow runs are plain Node scripts, so the whole packaging path can be
rehearsed locally with the current version (`X.Y.Z` below is the version in `manifest.json`):

```bash
npm ci
npm run release:check -- --version X.Y.Z          # version rules against the sources and (optionally) --latest vA.B.C
npm run build && npm run verify:manifest
npm run release:package -- --version X.Y.Z        # release/TokenLens-vX.Y.Z.zip, .sha256, provenance.json
npm run release:verify -- --zip release/TokenLens-vX.Y.Z.zip --version X.Y.Z --checksum release/TokenLens-vX.Y.Z.zip.sha256 --dist dist
unzip -t release/TokenLens-vX.Y.Z.zip             # or: python -m zipfile -t …   (an independent ZIP reader)
unzip release/TokenLens-vX.Y.Z.zip -d release/unpacked
TOKENLENS_EXTENSION_DIR=release/unpacked npx playwright test --project=extension
TOKENLENS_EXTENSION_DIR=release/unpacked npm run test:e2e:devtools   # headed: the packaged build inside real DevTools
```

`TOKENLENS_EXTENSION_DIR` points the `extension` and `devtools` Playwright projects at any
unpacked folder, so the artifact itself, not the local `dist/`, is what gets loaded into Chromium.
Note that a Windows checkout with `core.autocrlf=true` produces CRLF line endings in the two HTML
files, so its ZIP checksum differs from the Linux build's; the hosted run is the build of record.

The release scripts are covered by `npm run test:unit` (`test/unit/release/`), including the
Chrome Web Store client against mocked API responses; nothing there contacts the store.

| Command | Purpose |
| --- | --- |
| `npm run release:prepare -- X.Y.Z` | write the version into the three source files |
| `npm run release:check -- --version X.Y.Z --latest vA.B.C` | validate a version against the sources and history |
| `node scripts/release/check-inputs.mjs --github-release true --store none` | show how the Release workflow judges an input combination (exit 1 here: a release needs a store action) |
| `GITHUB_TOKEN=… node scripts/release/fetch-release.mjs --version X.Y.Z --repository <owner>/TokenLens --out release` | download and verify the package of an existing GitHub Release, as the retry does; needs a token that can read the repository |
| `npm run build && npm run release:package -- --version X.Y.Z` | build and produce `release/TokenLens-vX.Y.Z.zip` plus checksum and provenance |
| `npm run release:verify -- --zip <zip> --version X.Y.Z [--sha256 <hex>] [--checksum <file>] [--dist dist]` | re-verify a package: checksum, structure, and equality with a `dist/` |
| `npm run verify:manifest` | assert the built manifest keeps `permissions: []` and no background or content scripts |
