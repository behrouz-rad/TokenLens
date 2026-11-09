# CLAUDE.md: TokenLens engineering guide

Rules for anyone, human or AI assistant, who changes TokenLens. Read it before touching code.
Details live in the documents it points to: `README.md` (features, usage, commands),
`Architecture.md` (data flow, layers, test classes), `docs/release.md` (release procedure and owner
setup) and `docs/decisions/` (ADRs).

## 1. Project

TokenLens is a Manifest V3 Chrome DevTools extension. It adds a *TokenLens* tab that observes the
inspected page's network traffic while DevTools is open, extracts `Authorization: Bearer`
credentials, decodes JWTs locally, correlates each token with the requests that carried it, and
shows temporal diagnostics. A Decoder section decodes a pasted token without any captured traffic.
Everything runs inside the browser; nothing is transmitted anywhere.

Four sections exist and are fully functional: **Overview** (token inventory and selected-token
inspector), **Requests** (every captured Bearer request), **Timeline** (every token event,
observed events distinguished from claim-derived ones) and **Decoder** (manual, local decoding of
a pasted JWT with token-only diagnostics, isolated from capture). Storage inspection, OAuth/OIDC flow
inspection, signature verification, JWKS retrieval, JWE decryption, key input, token generation or
re-signing and a separate diagnostics dashboard are **not implemented and must not be advertised**. No placeholder navigation, "coming soon" entries or
interactive-looking stubs.

Stack: TypeScript, React 19, Vite + CRXJS, Tailwind CSS 4, Zustand, TanStack Table/Virtual,
react-resizable-panels, Radix Popover/Dialog, Lucide, Zod, date-fns, sonner. Tests: Vitest +
Testing Library, Playwright, axe-core.

## 2. Architecture boundaries

| Layer | Location | Must not |
| --- | --- | --- |
| Core (pure logic: JWT, manual-input normalisation, diagnostics, capture relay, session reducer, protocol, synthetic fixtures) | `src/core/**` | import React, Zustand or DOM-only APIs (`atob`, `TextDecoder`, `BroadcastChannel` only behind interfaces) |
| Capture service (DevTools-page relay) | `src/core/capture/relay.ts`, run by `src/devtools/devtools.ts` | touch UI state; retain any header other than the Bearer value |
| State (capture store, decoder store, UI preferences, clock, cross-section actions) | `src/state/**` | hold business rules that belong in `core` |
| Hooks (connect panel to relay, derive filtered views) | `src/hooks/**` | hold capture state of their own |
| Components (presentation) | `src/devtools/panel/**` | decode tokens, compute diagnostics, call Chrome APIs directly |
| Shared types and defaults | `src/types/index.ts` | contain logic |
| Release tooling (inputs, version, packaging, GitHub Release reader, store client) | `scripts/release/lib/*.mjs` with thin CLIs beside them | depend on the app; perform network or publishing side effects outside the CLIs |

**Invariants (tests enforce them; keep them true):**

1. One `Token` record per distinct Bearer value per session; `request.tokenId` and
   `token.requestIds` agree; `verifyReferentialIntegrity()` returns `[]` after every transition.
2. The session changes only through the pure functions in `src/core/capture/session.ts`. Requests
   and Timeline derive from that session and never copy it.
3. Decoding is not verification. UI and diagnostics may say "Signature present, not verified",
   "Unsigned", "Not measured"; never "verified", "valid signature", or invented JWKS data.
4. `TokenStatus` is temporal only (`active` means "exp is in the future").
5. Timeline events are observed (`captured`, `used-in-request`, `failed-request`) or claim-derived
   (`issued`, `expired`) and are labelled as such.
6. Observations are idempotent per `(relayId, seq)`; replays never duplicate. Clearing keeps the
   cursor and drops token-bound view filters.
7. Filters are per section: the toolbar Filters popover edits the Overview's token filter and is
   shown only there; Requests and Timeline own their filters; the Decoder has none; the status bar
   describes the active section (in the Decoder, the local decoding state).
8. No raw credential in persisted preferences, layout storage, logs, toasts, error messages, test
   artifacts or screenshots. Previews show a short prefix only.
9. `manifest.json` keeps `permissions: []`, no `host_permissions`, no background, no content
   scripts. `scripts/verify-manifest.mjs` checks the built manifest in CI and before release.
10. The Decoder is isolated: pasted input lives only in `src/state/decoder-store.ts`, never becomes
    a `Token`, request or event, never changes selection, filters, recording or counts, and is never
    persisted. Diagnostics take a `DiagnosticSubject`, so reuse never needs a fabricated `Token`;
    HTTP-evidence checks are not run for it. Capture Clear and Decoder *Clear input* affect only
    their own data. A result that does not describe the current input is never shown as current.

## 3. Workflow for every change

Bug fixes, refactors, dependency upgrades and features all follow this order:

1. Read this file; inspect the affected implementation and its tests.
2. Reproduce the defect or pin down the requirement; find the root cause, not the symptom.
3. List the scenarios and invariants (§2) the change touches.
4. Write or update the regression test first (unit for `core`/state/scripts, component for UI,
   E2E for browser behaviour).
5. Implement the smallest correct change.
6. `npm run test`, then `npm run typecheck` and `npm run lint`.
7. `npm run build` and `npm run verify:manifest`.
8. `npm run test:e2e`. If a visual change is intended, regenerate baselines for the local platform
   (`npx playwright test --project=panel-ui --update-snapshots=all`) and for CI
   (`npm run test:e2e:baselines`, Docker) and review the images.
9. If the change affects capture, the DevTools page, the manifest, layout, navigation or anything
   a user sees: `npm run test:e2e:devtools` (headed, real DevTools) and look at `e2e/.artifacts/*.png`.
10. Review the diff for stray comments, debug output, token values, dated notes and scope creep;
    update README, Architecture.md, `docs/release.md` and ADRs when behaviour or structure changed.
11. Report what was run, the results, and anything that could not be verified.

Never: skip or `.only` tests to get green, weaken assertions or widen screenshot tolerances to
match behaviour, add `eslint-disable` or `@ts-expect-error` to hide a problem, add sleeps to mask
flakiness, or claim a test passed without running it.

Every bug fix names the root cause in the commit or pull request, includes a reproducible scenario
and a regression test, preserves unrelated behaviour, never swallows exceptions silently, and is
verified in the real extension when it concerns capture or rendering inside DevTools.

## 4. Testing

| Command | Runs | Notes |
| --- | --- | --- |
| `npm run typecheck`, `npm run lint` | `tsc` (app, tests, tooling), ESLint type-checked | must be clean |
| `npm run test` | Vitest `unit` (node; includes `test/unit/release/`) and `component` (jsdom) | jsdom over-renders virtual lists, so DOM-size bounds belong in E2E |
| `npm run build`, `npm run verify:manifest` | production `dist/`, manifest posture | build is required before any E2E |
| `npm run test:e2e` | Playwright `panel-ui` + `extension` only | `panel-ui` = built `panel.html` fed through the real BroadcastChannel protocol; `extension` = unpacked extension in Chromium. A unit test pins this project selection. |
| `npm run test:e2e:baselines` | `panel-ui` inside the pinned Playwright Docker image, updating `e2e/tests/__screenshots__/linux/` | `:check` compares only; `test/unit/toolchain.test.ts` keeps the image tag equal to `@playwright/test` |
| `npm run test:e2e:devtools` | Playwright `devtools`, headed | real Chrome DevTools over CDP; the only proof of DevTools registration and `chrome.devtools.network` capture; its `e2e/.artifacts/` screenshots (all four sections) are what `docs/evidence/` is refreshed from. Needs a desktop session; not in CI; run before every release |
| `npm run check` | typecheck + lint + test + build + manifest check | local equivalent of the CI quality job |

Screenshots are compared strictly (`maxDiffPixels: 0`, `threshold: 0.1`) per platform. CI runs
E2E inside the same pinned Playwright image the Linux baselines come from. Use synthetic tokens
only (`src/core/testing/synthetic.ts`, `e2e/fixture/app.html`); prefer fake timers over waits.
`TOKENLENS_EXTENSION_DIR` points the `extension` and `devtools` projects at another unpacked
folder, such as an extracted release ZIP.

## 5. Security rules

- Bearer values are secrets: they live in `Token.raw` in memory and nowhere else. Never log them,
  put them in error messages, persist them, or use real ones in fixtures or screenshots.
- Only the Bearer credential crosses the relay boundary; every other header is dropped in
  `harEntryToObservation`.
- Persistence is limited to `tokenlens-preferences` and `tokenlens-layout` in `localStorage`,
  validated with Zod on load. Decoder input and results are never persisted (no storage, URL,
  IndexedDB or logs), and the token field keeps spell checking and autocorrection off.
- Clipboard writes happen only from explicit user clicks, show feedback and handle failure.
- No new permissions, host permissions, content scripts, background workers, remote scripts or
  `unsafe-eval`. Any change there needs an ADR and review.
- Claims are data: render through React text nodes, cap JSON depth, never `eval` or
  `dangerouslySetInnerHTML`.
- Terminology: "decoded", "not verified", "unsigned", "signature present". Never "verified" or
  "valid" for cryptographic properties.
- Release credentials never enter the repository or logs. The store token is short-lived, read from
  an environment variable and never printed; release scripts receive network and time by
  injection so tests never contact the store.
- Committing credentials is prohibited. If one is found: remove it, rotate it, add a test that
  fails if it reappears. Removing a file from the latest commit does not remove it from history.

## 6. Code and documentation standards

- TypeScript strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`; no `any`, no non-null
  assertions in `src/` (tests may use `!` on fixtures they built). Release scripts are JavaScript
  modules with JSDoc types and are type-checked through the tests that import them.
- Errors are handled at the boundary (relay, clipboard, storage, release CLIs) by degrading
  visibly; no empty `catch {}` without a comment explaining why ignoring is correct.
- Comments explain *why* (a browser limitation, a security decision, an invariant, a workaround, a
  non-obvious contract), never what the code does or how a change was made. Keep JSDoc on public
  APIs and non-obvious contracts.
- Public documents contain no AI transcripts, prompts, implementation diaries, dated status notes
  or unsupported feature claims. ADRs are numbered, undated (`Status: Accepted`) and written only
  for durable architecture or security decisions (new capture mechanism, storage, permission,
  verification feature, publishing mechanism, dependency replacement).
- Names describe domain concepts (`observation`, `relay`, `session`, `fingerprint`); files are
  kebab-case; one component per file unless helpers are tiny and private.
- New dependencies need a reason in the pull request and must be stable releases with matching
  peer ranges. Upgrade in groups that share peer ranges (Vite ↔ plugins ↔ Vitest; TypeScript ↔
  typescript-eslint; Playwright ↔ its Docker image tag), read every major's migration guide,
  reinstall from scratch, run `npm audit` and the full workflow (§3). A `package.json` override
  is acceptable only to lift a transitive dependency to a patched release that its parents do not
  yet allow; it needs the advisory in the pull request, a test that pins it to one installed
  version (`test/unit/toolchain.test.ts`), and removal once the parents catch up.
- UI: reuse `IconButton`, `Popover`, `StatusBadge`, `EmptyState`, `FilterChip`; every control has an
  accessible name; every scrollable region is focusable; dark and light themes pass axe WCAG AA.
- Prefer a small function over a new abstraction; prefer deleting over generalising.

## 7. Releases

- CI (`.github/workflows/ci.yml`) is a quality gate only and never publishes.
- Releases are manual: *Prepare release* opens a version-bump pull request; after merging, the
  owner runs *Release* with the version. The workflow validates the version against the sources,
  tags and latest release, runs every gate, builds once, packages a deterministic ZIP with a
  SHA-256 checksum and provenance, proves the tested build is the packaged build, and only then,
  if asked, creates the tag and GitHub Release and uploads or submits the same ZIP to the Chrome
  Web Store.
- A dry run (`github_release` off, `store` = `none`) publishes nothing and is the way to rehearse.
  Every other combination needs both: a real release always schedules a store action
  (`scripts/release/lib/inputs.mjs`). A store submission is a review request, not a publication.
- *Retry Chrome Web Store* resumes the store step of an existing release from the release's own
  verified assets. It never rebuilds, tags or creates a release, leaves a version alone that the
  store already shows as submitted or published, and re-uploads the released package otherwise,
  only with the explicit `replace_draft` input (the API cannot show what a draft contains).
- `manifest.json`, `package.json`, the lockfile, the toolbar badge (injected from the manifest at
  build time), the artifact name, the tag and the release always agree on `MAJOR.MINOR.PATCH`.
- Before a release: `npm run test:e2e:devtools` headed against the extracted release ZIP
  (`TOKENLENS_EXTENSION_DIR`), and keep the screenshots.
- Procedure, guarantees, retry, local dry run and owner setup: `docs/release.md`; rationale:
  ADR 0004 and ADR 0005.

## 8. Definition of done

A change is done only when: requirements are implemented; relevant unit, component and E2E tests
pass; typecheck and lint are clean; the production build succeeds with a minimal manifest; browser
behaviour was verified in the real extension where relevant; README, Architecture.md,
`docs/release.md` and ADRs are updated; no known regression is left unreported; and anything
unverified is named explicitly in the report.
