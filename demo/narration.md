# Narration

Voice: Kokoro-82M, voice `af_heart` (American English), speed 1.1, synthesized locally by
`scripts/narrate.mjs`. The source of truth is `LINES` in [`scenes.mjs`](scenes.mjs). Captions show
the left column. Where the voice needs a different spelling to pronounce a term well, the spoken
text is listed too. Every clip is checked by transcribing it with Whisper
(`node scripts/narrate.mjs --verify`).

| # | Scene | Line (caption) | Spoken as |
| --- | --- | --- | --- |
| 1 | Intro | Meet TokenLens: JWT and Bearer token inspection, right inside Chrome DevTools. | "J.W.T." spelled out |
| 2 | Capture | Open DevTools, use your app, and TokenLens catches every Bearer token. | |
| 3 | Capture | One record per credential, with a live status counting down to expiry. | |
| 4 | Decode | Select a token to decode it locally: | |
| 5 | Decode | claims, scopes and expiry, all in plain sight. | |
| 6 | Decode | Diagnostics check expiry and key claims, and say what was not verified. | |
| 7 | Requests | Requests shows every authenticated call and the token that carried it. | |
| 8 | Requests | Filter to failures, and the culprit stands out: | |
| 9 | Requests | an expired token behind every 401. | "four-oh-one" |
| 10 | Timeline | The Timeline puts every event in order: | |
| 11 | Timeline | observed requests, plus issue and expiry times from each token's claims. | |
| 12 | Outro | Everything stays in your browser. TokenLens: inspect locally, understand instantly. Free on the Chrome Web Store. | |

## Why each line is accurate

- **"catches every Bearer token"**: within what DevTools reports while it is open, which is the
  scenario shown (README, *Known limitations*).
- **"One record per credential"**: invariant 1, one `Token` per distinct Bearer value.
- **"live status counting down to expiry"**: status is temporal only and updates on its own
  deadline. *Active* means "not expired", not "trusted".
- **"decode it locally"**: decoding happens in the panel, and nothing is transmitted.
- **"say what was not verified"**: the diagnostics show *Signature present, not verified*,
  *Present. Whether it matches the receiving API was not checked*, and clock skew *Not measured*.
  The video never claims verification.
- **"issue and expiry times from each token's claims"**: Timeline marks these as *CLAIM* events,
  apart from *OBSERVED* ones.
- **"Everything stays in your browser" / "Free"**: no network requests, no permissions, and the
  store listing is free of charge (`docs/store/listing.md`).
