# ADR 0001: Capture runs in the DevTools page and reaches the panel over BroadcastChannel

- Status: Accepted
- Scope: `src/core/capture/relay.ts`, `src/core/capture/channel.ts`, `src/devtools/devtools.ts`, `src/hooks/use-capture-connection.ts`

## Context

The first implementation subscribed to `chrome.devtools.network.onRequestFinished` from a React
effect inside the panel. Capture therefore started only when the TokenLens tab was first shown,
stopped whenever React unmounted the hook, and double-registered listeners under StrictMode and
hot reload. Requests made while the user was on another DevTools tab were lost.

Two browser facts constrain any design:

1. `chrome.devtools.*` APIs exist only in the extension's `devtools_page` and in panels it creates.
2. Only traffic recorded after DevTools opened is visible, and in practice `onRequestFinished` is
   not delivered for every recorded request (Chromium 156: requests made before the first
   navigation after DevTools opened never fire it, although `getHAR()` returns them).

## Alternatives

- Keep capture in the panel (status quo): loses traffic until the tab is shown; lifecycle bugs.
- Add a background service worker and route events through `chrome.runtime` messaging: an extra
  process, extra permissions surface, and the worker still has no access to `chrome.devtools`.
- Pass the panel `window` from `panel.onShown` and call into it directly: couples the two documents
  through globals and only works after the panel has been shown once.
- BroadcastChannel between the DevTools page and the panel (chosen).

## Decision

A `CaptureRelay` runs in the DevTools page for the life of the DevTools window. It registers the
network and navigation listeners exactly once, polls `getHAR()` to reconcile requests the event
missed, de-duplicates both sources by request key, converts each entry into a sanitised
`RequestObservation` (URL, method, status, timing, Bearer value, nothing else), keeps a bounded
replay buffer, and publishes batches on a `BroadcastChannel` named with the inspected tab id.
The panel says `hello` on mount, receives a replay, and ingests live batches. A per-relay
sequence cursor in the capture session makes replay idempotent.

## Consequences

- Capture starts when DevTools opens, not when the panel is shown.
- The panel can mount, unmount and reload freely; StrictMode double mounting is harmless.
- Two DevTools windows never mix data: the channel name embeds the tab id and messages are
  filtered by scope.
- Recording pause is a panel-side decision: observations received while paused are skipped and
  are not backfilled on resume (the cursor still advances).
- DevTools recreates the panel frame on inspected-page navigation. The new panel replays from the
  relay, so Clear also sends a `clear` message that empties the relay's replay buffer (seen keys
  are kept so nothing is re-emitted). The relay then withholds every request that started before
  the Clear, including ones still in flight or awaiting confirmation, so cleared traffic cannot
  come back through a later poll or live event.
- `getHAR()` polling costs one serialisation per second while the log is small and every five
  seconds once it exceeds 2 000 entries. This is the price of reliable capture.
- `getHAR()` reports requests before they finish, so polled entries are reconciled with the live
  events rather than trusted as they come: in-flight entries are skipped, the request key ignores
  the duration that is still changing, and a completed entry seen only in a poll is emitted once a
  later poll shows it unchanged. A request seen only through polling therefore appears one poll
  later, and a request that never completes is not listed. A snapshot superseded by a later
  failure of the same request is discarded rather than emitted.
- No background worker and no additional permissions.

## Validation

- Unit tests: `test/unit/relay.test.ts` (listener lifecycle, HAR/live reconciliation, batching,
  replay buffer, navigation, failure tolerance), `test/unit/session.test.ts` (cursor idempotency).
- Component test: `test/component/capture-connection.test.tsx` (StrictMode, pause).
- Real DevTools: `e2e/tests/devtools/real-devtools.spec.ts` drives Chrome's DevTools window over
  CDP, opens the TokenLens tab and verifies live capture from the inspected page.
