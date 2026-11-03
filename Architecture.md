# TokenLens architecture

This document describes how the extension is put together. The README covers what it does and
how to use it; `CLAUDE.md` holds the engineering rules; `docs/decisions/` records why the larger
choices were made.

## Runtime topology

```
chrome://extensions (unpacked dist/ or the store package)
└── manifest.json  — MV3, devtools_page only, permissions: []
    ├── src/devtools/devtools.html → devtools.ts        hidden DevTools page, lives while DevTools is open
    │     CaptureRelay: chrome.devtools.network listeners + getHAR() polling → BroadcastChannel
    │     chrome.devtools.panels.create('TokenLens', …, panel.html)
    └── src/devtools/panel/panel.html → main.tsx → App   the visible TokenLens tab
          useCaptureConnection: hello → replay → live batches → capture store → React
```

Both documents share the extension origin, so a `BroadcastChannel` named
`tokenlens:capture:<inspectedTabId>` connects them without a background worker. Each DevTools
window inspects one tab, so the tab id isolates sessions. Outside DevTools (dev server, UI tests)
the scope is `standalone`.

## Data flow

```
HAR entry (onRequestFinished | getHAR poll)
  → harEntryKey de-dup (relay)                                   src/core/capture/observation.ts, relay.ts
  → RequestObservation { url, method, status, statusText, startedAt, durationMs, bearerToken }
  → batched 'observations' message / 'snapshot' replay            src/core/capture/channel.ts
  → useCaptureConnection → captureStore.ingest(batch, {recording, clearOnNavigation})
  → ingestObservations (pure reducer)                              src/core/capture/session.ts
       cursor check (relayId, seq) → analyzeBearerToken → fingerprint index lookup
       → canonical Token (new or existing) → NetworkRequest{tokenId} → TimelineEvent
       → enforceLimits → refreshStatuses
  → Zustand state → hooks (useTokenListView, useSelectedToken, useRequestExplorer, useGlobalTimeline)
  → sections: Overview (token list, header, claims, per-token timeline and requests, payload, diagnostics)
              Requests (all captured requests)   Timeline (all events)
```

## Layers

| Path | Role |
| --- | --- |
| `src/core/jwt/` | `base64url.ts` (strict decoding, UTF-8), `decoder.ts` (`analyzeBearerToken` → jwt / malformed-jwt / opaque / unsupported, claim issues, standards-based classification, temporal status and next transition), `fingerprint.ts` |
| `src/core/diagnostics/engine.ts` | `runDiagnostics(token, now, threshold)` and `runRequestDiagnostics(requests)`; pure, time injected |
| `src/core/capture/` | `observation.ts` (sanitised record + key), `relay.ts` (DevTools-page service), `channel.ts` (protocol + BroadcastChannel port), `session.ts` (state reducer, eviction, integrity check) |
| `src/core/testing/synthetic.ts` | synthetic JWT and observation builders used by dev seeding and tests |
| `src/state/` | `capture-store.ts` (session, token/request/timeline filters, exact-deadline expiry timer), `ui-store.ts` (validated, persisted preferences), `clock.ts` (shared 1 s ticker), `capture-actions.ts` (clear, cross-section navigation) |
| `src/hooks/` | `use-capture-connection.ts`, `use-filtered-tokens.ts`, `use-selected-token.ts`, `use-request-explorer.ts`, `use-global-timeline.ts`, `use-container-width.ts` |
| `src/devtools/panel/` | `app.tsx` (sections, three-column layout, narrow mode, dialog), `components/` (layout, sidebar, ui), `features/` (tokens, requests, timeline, diagnostics) |
| `src/lib/` | `format.ts`, `clipboard.ts`, `layout-storage.ts`, `token-status.ts`, `cn.ts` |
| `src/types/index.ts` | domain types and defaults |

## Key behaviours

- **Canonical identity.** The fingerprint index maps a 64-bit hash of the raw value to token ids;
  a hit is confirmed by comparing `raw`. Requests always store the canonical `tokenId`; tokens list
  their `requestIds`; events are filed per token. `verifyReferentialIntegrity` checks all of this.
- **Idempotent delivery.** Every observation carries `(relayId, seq)`. The session keeps the highest
  processed `seq` per relay, so replays (panel reload, StrictMode) never duplicate. Clearing keeps
  the cursor and also tells the relay to drop its replay buffer (`clear` message).
- **Recording.** Paused observations are counted as skipped and never backfilled.
- **Navigation.** Data is preserved across navigations by default; the *Clear on navigation*
  setting resets the session when the relay reports `onNavigated`.
- **Expiry.** The store computes the next instant any token changes status and arms one timer.
  Relative labels re-render from a shared 1 s ticker; only subscribed components update.
- **Limits.** Defaults 500 tokens / 5 000 requests. Tokens are evicted least-recently-seen first
  (the selected token is protected), requests oldest first, with their events; the status bar shows
  eviction counts. The relay keeps a 5 000-observation replay buffer and 20 000 seen keys.
- **Cross-token views.** Requests and Timeline derive from the same session maps; they hold only
  view filters (`requestFilter`, `timelineFilter`) and a transient `focusedRequestId`. A filter
  bound to an evicted or cleared token resolves to an explicit empty state rather than stale rows.
- **Filter scope.** Three independent filters exist: the token-inventory filter (`filter` plus
  `showExpired`) narrows only the Overview's token list; `requestFilter` and `timelineFilter`
  narrow their own sections. The toolbar's Filters popover edits the token filter and is rendered
  only in the Overview; Requests and Timeline expose their filters inline. The status bar summary
  describes the active section's filter, so a count there always refers to what is on screen.
- **Timeline provenance.** `captured`, `used-in-request` and `failed-request` events are observed in
  traffic; `issued` and `expired` are placed from the token's own `iat`/`exp` claims and are marked
  as claim-derived. TokenLens never infers that a token was issued or refreshed from observing it.
- **Diagnostics wording.** See ADR 0003. No state claims cryptographic verification.
- **Layout.** `react-resizable-panels` `Group`/`Panel`/`Separator`; layout persisted as percentages
  in `localStorage`. Under 720 px the Overview becomes a single column with Tokens / Details /
  Inspector views; Requests and Timeline always use the full width.
- **Version badge.** `__APP_VERSION__` is injected at build time from `manifest.json`.

## Browser lifecycle constraints

- `chrome.devtools.*` exists only in the DevTools page and its panels; the relay therefore lives in
  the DevTools page and starts with DevTools.
- Only traffic after DevTools opened is observable. `onRequestFinished` has been observed not to
  fire for requests made before the first navigation after DevTools opened; the relay polls
  `getHAR()` (1 s, slowing to 5 s above 2 000 entries) and de-duplicates by request key.
- DevTools recreates the extension panel frame on inspected-page navigation. The relay survives
  and the new panel resynchronises from the replay buffer.
- Branded Google Chrome ignores `--load-extension`; automation uses Playwright's Chromium.

## Testing strategy

| Class | Location | Proves |
| --- | --- | --- |
| Unit (node) | `test/unit/` | decoder, diagnostics, observation sanitising, session reducer and invariants, relay reconciliation, store timers and filters, request/timeline derivations, formatting, preferences, toolchain pins; `test/unit/release/` covers the release scripts (workflow input rules, version rules, deterministic ZIP packaging checked against an independent ZIP tool, provenance schema, GitHub Release asset reuse, Chrome Web Store client and recovery policy against mocked API responses, CLI exit codes against a local HTTP server, workflow structure) |
| Component (jsdom) | `test/component/` | App shell and navigation, token list, inspector components, Requests explorer, global Timeline, capture connection hook |
| E2E `panel-ui` | `e2e/tests/panel/` | built `panel.html` as a page fed via the real BroadcastChannel protocol: capture flow, filters, pause/clear, clipboard, time advance, Requests and Timeline sections, theme/layout, visual baselines, axe WCAG AA, keyboard, reliability/eviction/bursts |
| E2E `extension` | `e2e/tests/extension/` | manifest minimality, extension loads with no errors, panel runs in the extension origin, no external requests |
| E2E `devtools` (headed) | `e2e/tests/devtools/` | real DevTools window: TokenLens tab registered and reachable, panel iframe attached over CDP, live fixture traffic captured and correlated, all three sections, controls, themes, reload behaviour, no runtime errors |

Visual baselines live under `e2e/tests/__screenshots__/<platform>/`. The `linux` set is generated in
the pinned Playwright container (`npm run test:e2e:baselines`) and is what CI compares against; the
`win32` set serves local Windows runs. Comparisons are strict: no differing pixel is tolerated (`maxDiffPixels: 0`, `threshold: 0.1`).
The toolbar version badge is masked so a version bump does not invalidate the baselines; its text is
asserted against `manifest.json` by a separate test.

Fixture: `e2e/fixture/server.mjs` serves a synthetic app (`/app/`) with scenario buttons and API
endpoints returning 200/201/401/403/500, plus `dist/` as static files.
