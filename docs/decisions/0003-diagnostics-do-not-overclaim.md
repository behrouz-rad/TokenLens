# ADR 0003: Diagnostics report evidence, never verification TokenLens did not perform

- Status: Accepted
- Scope: `src/core/diagnostics/engine.ts`, `src/core/jwt/decoder.ts`, diagnostics and header UI

## Context

The original engine showed a green "Signature is present" check, called HS256 weak, reported a
fabricated "2 keys available" JWKS line whenever a `kid` existed, and labelled `Date.now() - iat`
as clock skew. Each of these could lead a developer to a wrong conclusion about a credential.

## Decision

- Signature: TokenLens does not verify signatures. The only states are
  `Signature present, not verified` (info), `Unsigned` (alg none or empty signature, error) and
  `No signature (not a JWT)`. No green indicator is ever derived from a non-empty third segment.
- Algorithm: recognised algorithms are reported as information with context (symmetric vs
  asymmetric). `none` is an error. Unknown names are warnings. No algorithm is called secure.
- JWKS: not retrieved in v1. A `kid` is shown as information with the note that key matching is
  not performed.
- Clock skew: shown as `Not measured` because no independent server time reference exists.
- Temporal checks use validated NumericDate claims; `exp = 0` is expired, a missing `exp` is "not
  evaluated", invalid types are errors. Statuses are temporal only: `active`, `expiring`,
  `expired`, `not-yet-valid`, `no-expiry`, `malformed`.
- HTTP 401/403 are presented as evidence with possible causes; TokenLens cannot see the server's
  reason.
- Token type inference uses standards-based indicators only (`typ: at+jwt`, OIDC ID-token claims)
  and always exposes the basis for the classification.

## Consequences

Fewer green ticks, more honest wording. Signature verification and JWKS retrieval remain explicit
future features and must introduce new states (`verified`, `verification failed`) rather than
reinterpret the existing ones.

## Validation

`test/unit/diagnostics.test.ts`, `test/unit/decoder.test.ts`, component and E2E assertions that the
strings "keys available" and "verified" (without "not") never appear.
