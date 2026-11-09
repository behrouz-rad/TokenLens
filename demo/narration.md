# Narration

Voice: Kokoro-82M, voice `af_heart` (American English), speed 1.1, synthesized locally by
`scripts/narrate.mjs`. The source of truth is `LINES` in [`scenes.mjs`](scenes.mjs). Captions show
the left column. Where the voice needs a different spelling to pronounce a term well, the spoken
text is listed too. Every clip is checked by transcribing it with Whisper
(`node scripts/narrate.mjs --verify`).

| # | Scene | Line (caption) | Spoken as |
| --- | --- | --- | --- |
| 1 | Intro | Meet TokenLens: JWT and Bearer token inspection, right inside Chrome DevTools. | "J.W.T." spelled out |
| 2 | Capture | Open DevTools, use your app, and TokenLens collects the Bearer tokens it sends. | |
| 3 | Capture | One record per credential, with a live status counting down to expiry. | |
| 4 | Decode | Select a token to decode it locally: | |
| 5 | Decode | claims, scopes and expiry, all in plain sight. | |
| 6 | Decode | Diagnostics check expiry and key claims, and say what was not verified. | |
| 7 | Requests | Requests lists every Bearer-authenticated call and the token it used. | |
| 8 | Requests | Filter failed requests, then inspect the token they used. | |
| 9 | Requests | Here, both 401s used an expired token. | "four-oh-ones" |
| 10 | Timeline | The Timeline puts every event in order: | |
| 11 | Timeline | observed requests, plus issue and expiry times from each token's claims. | |
| 12 | Decoder | Have a token from somewhere else? Paste it into the Decoder. | |
| 13 | Decoder | It decodes on the spot, with no network request. | |
| 14 | Decoder | Claims at a glance, with the signature marked not verified. | |
| 15 | Decoder | Inspect header and payload, switch to raw JSON, | |
| 16 | Decoder | and copy what you need. | |
| 17 | Outro | Everything stays in your browser. TokenLens: inspect locally, understand instantly. Free on the Chrome Web Store. | |

## Why each line is accurate

- **"collects the Bearer tokens it sends"**: scoped to the app's own traffic while DevTools is
  open, which is what the `chrome.devtools.network` API reports (README, *Known limitations*).
- **"One record per credential"**: invariant 1, one `Token` per distinct Bearer value.
- **"live status counting down to expiry"**: status is temporal only and updates on its own
  deadline. *Active* means "not expired", not "trusted".
- **"decode it locally"**: decoding happens in the panel, and nothing is transmitted.
- **"say what was not verified"**: the diagnostics show *Signature present, not verified*,
  *Present. Whether it matches the receiving API was not checked*, and clock skew *Not measured*.
  The video never claims verification.
- **"every Bearer-authenticated call"**: Requests lists requests that carried a Bearer token;
  others are counted, not listed.
- **"inspect the token they used" / "both 401s used an expired token"**: an observation, not a
  diagnosis. The two 401s from `billing.example.test` carried a token whose `exp` had passed; the
  third failure in the filter (a 403) used an active token, so the line names only the 401s.
  TokenLens does not claim to know why a server answered as it did.
- **"issue and expiry times from each token's claims"**: Timeline marks these as *CLAIM* events,
  apart from *OBSERVED* ones.
- **"Paste it into the Decoder" / "no network request"**: the Decoder decodes pasted input in the
  panel and never sends it anywhere (CLAUDE.md invariant 10). The recorder checks that the paste
  adds no captured token or request.
- **"the signature marked not verified"**: the Decoder shows *Signature present, not verified*
  and *JWT decoded · signature not verified*. Nothing is verified, decrypted or re-signed.
- **"Everything stays in your browser" / "Free"**: no network requests, no permissions, and the
  store listing is free of charge (`docs/store/listing.md`).
