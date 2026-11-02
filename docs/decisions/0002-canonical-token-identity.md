# ADR 0002: One capture session reducer owns tokens, requests and events

- Status: Accepted
- Scope: `src/core/capture/session.ts`, `src/state/capture-store.ts`

## Context

Tokens, requests and timeline events lived in three independent Zustand stores. The network
listener generated a fresh token id for every request, then asked the token store whether the raw
value already existed; the request had already been saved with the fresh id, and the timeline
event sometimes used one id and sometimes the other. Deduplication scanned every token on every
request, and nothing bounded growth or kept the three stores consistent under eviction.

## Alternatives

- Patch the listener to look up the token before creating the request, keeping three stores:
  fixes the immediate mismatch but leaves eviction, clearing and replay to coordinate three
  stores by hand.
- One reducer with a single state object holding all collections (chosen).

## Decision

`CaptureState` holds `tokens`, `requests`, `eventsByToken`, a fingerprint index, counters,
sequence numbers, the selected token and limits. `ingestObservations` is a pure function that
processes a batch: it resolves the canonical token through the fingerprint index (verifying the raw
value on a hit, so hash collisions degrade to a longer bucket, never a wrong match), creates the
request with that id, appends it to the token, and records the timeline event, all in one
transaction. Collections are cloned once per batch, not once per event. Eviction removes a token
with its requests and events, or a request from its token and event list, in the same step.
`verifyReferentialIntegrity` encodes the invariants and is asserted by every session test.

The Zustand store is a thin wrapper that holds the session plus UI filter state and schedules the
next expiry transition.

## Consequences

- Exactly one token record per distinct Bearer value per session; requests always reference it.
- Clearing resets identities but keeps the relay cursor so a replay cannot resurrect cleared data.
- Limits are enforced with consistent cleanup; the selected token is protected from eviction and
  selection is cleared if it is removed.
- The raw credential is never used as a Map key; the index key is a 64-bit fingerprint.

## Validation

`test/unit/session.test.ts` covers first/repeat/distinct tokens, same token across endpoints and
concurrent requests, failed requests, duplicate delivery, pause, navigation, clearing and re-use,
eviction, status refresh, and a 6 000-request / 300-token workload with integrity checks.
