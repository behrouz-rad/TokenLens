# ADR 0004: Releases are manual, reproducible and separated from publishing

- Status: Accepted
- Scope: `.github/workflows/release.yml`, `.github/workflows/prepare-release.yml`, `scripts/release/`, `docs/release.md`

## Context

TokenLens ships as a Chrome extension. A release has three outputs that must agree: the version in
`manifest.json`, the ZIP uploaded to the Chrome Web Store, and the git tag and GitHub Release that
let anyone audit what was shipped. Continuous integration already proves quality on every pull
request, but publishing is a product decision with external consequences (store review, user
updates), and store credentials are the most sensitive secret the project could hold.

## Alternatives

- Publish on every push or tag to `main`: removes the human decision and turns an accidental merge
  into a public release.
- Let the release workflow bump the version and push to `main`: incompatible with branch
  protection, and the tag would point at a commit nobody reviewed.
- Build once for GitHub and again for the store: two artifacts that can silently differ.
- Store a Google service-account JSON key as a repository secret: a long-lived credential that
  anyone with workflow write access could exfiltrate.

## Decision

1. Releases start only from the Actions tab (`workflow_dispatch`) on `main`, by the repository
   owner or a login listed in the `RELEASE_PUBLISHERS` variable. CI never publishes.
2. The release version must already be committed on `main`. The *Prepare release* workflow writes
   it into `manifest.json`, `package.json` and `package-lock.json` and opens a pull request; the
   *Release* workflow refuses any version that differs from the sources, that already has a tag,
   or that is not higher than the latest release (an explicit override with a recorded reason
   exists for emergencies).
3. One build produces `dist/`; the same `dist/` is tested by Playwright and zipped by a
   deterministic, dependency-free packager (`scripts/release/zip.mjs`) so the archive and its
   SHA-256 are reproducible. The ZIP is verified structurally (manifest at the root, correct
   version, no development files, no fixture or secret-shaped content) before any publishing job
   runs, and every later job re-checks the checksum.
4. Publishing is staged behind inputs and protected environments: *dry run* (package only), or
   *GitHub Release* (tag plus assets plus provenance) together with a Chrome Web Store action
   that can stop at an uploaded draft, submit for review with automatic publish on approval, or
   submit as a staged publish that the owner releases from the dashboard. ADR 0005 makes the
   store action mandatory for a real release and adds the retry workflow for a store step that
   fails after the GitHub Release exists.
5. Store authentication uses Google Workload Identity Federation: the job exchanges its GitHub
   OIDC token for a short-lived access token scoped to `chromewebstore`. No key file is created or
   stored. The identifiers needed (publisher, extension, provider, service account) live in
   GitHub environment variables, not in the repository.

## Consequences

- Two clicks separate a release from a merge: preparing the version and running the release.
- A store submission cannot exist without a GitHub Release. A GitHub Release whose store step
  failed is completed with the *Retry Chrome Web Store* workflow (ADR 0005), never by re-running
  the release.
- A store submission is not a publication: approval and timing belong to Google and are reported,
  never assumed.
- The first store submission still needs manual dashboard work (listing, privacy disclosures,
  verification) that the workflow cannot do; it fails with a clear message when configuration is
  missing instead of guessing.
- Creating a brand-new store item is not possible through the API; the item id is created once
  in the dashboard and recorded as a variable.

## Validation

- `test/unit/toolchain.test.ts` keeps the workflows' Playwright image in step with the installed
  version, `manifest.json` in step with `package.json`, and the Playwright scripts on their
  intended projects.
- `test/unit/release/` tests the release libraries and CLIs in throwaway checkouts: version rules
  and monotonicity, deterministic packaging (byte-identical archives, checksums, provenance),
  structural rejection of development files and fixture content, agreement with an independent
  ZIP implementation, and the Chrome Web Store client against mocked API responses for every
  action and failure mode. No test touches the repository's version files or the real store.
- The *Release* workflow's E2E job verifies, with `scripts/release/verify-package.mjs`, that the
  `dist/` it tests is file-for-file the content of the release ZIP and that the ZIP carries the
  recorded checksum.
- The *Release* workflow's dry-run mode runs the full pipeline without creating a tag, a release
  or a store upload, and is the way to rehearse before credentials exist.
