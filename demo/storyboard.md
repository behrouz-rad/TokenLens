# Storyboard

Final cut: `tokenlens-demo.mp4`, 59.1 s, 1920×1080, 30 fps. Times come from the last render.
They shift by a few tenths of a second between takes, because each step lasts as long as its
narration and the real UI takes to respond. Scenes 2–5 are the real extension in real Chrome
DevTools (dark theme), filmed at 2× and edited by Screenplay. Scenes 1 and 6 are rendered from
`brand/brand.html`. Cross-fades between the cards and the product footage are 0.6 s.

| Time | Scene | On screen | Narration | What it proves |
| --- | --- | --- | --- | --- |
| 0.0–6.9 | **1 · Hook** | Backdrop of indigo/violet light. The TokenLens icon draws itself (ring, lens, handle), then the wordmark, the subtitle, and a synthetic JWT split into Header · Payload · Signature. | "Meet TokenLens: JWT and Bearer token inspection, right inside Chrome DevTools." | Identity and value in the first seconds. |
| 6.3–13.5 | **2 · Capture** | DevTools opens on Elements. The cursor clicks the *TokenLens* tab, and the panel fills live as the app sends 12 requests: 6 tokens across 3 hosts. | "Open DevTools, use your app, and TokenLens catches every Bearer token." | Capture is automatic and lives in DevTools. |
| 13.5–19.0 | 2 · Inventory | Spotlight on the token list: Active, Expiring, No expiry, opaque Bearer. | "One record per credential, with a live status counting down to expiry." | Deduplicated inventory with temporal status. |
| 19.0–21.5 | **3 · Decode** | Click the Expiring `access_token #3`. The header, claims and payload switch to it. | "Select a token to decode it locally:" | Local decoding, per token. |
| 21.5–24.9 | 3 · Claims | The camera frames the Claims Summary (iss, sub, aud, exp, iat, jti, scope). | "claims, scopes and expiry, all in plain sight." | Readable claims and scopes. |
| 24.9–30.5 | 3 · Diagnostics | Spotlight on Diagnostics: *Signature present, not verified*, algorithm, exp/nbf/iat checks, audience *not checked*. | "Diagnostics check expiry and key claims, and say what was not verified." | Honest diagnostics; no claim of verification. |
| 30.5–34.8 | **4 · Requests** | Wide shot of Requests: 12 calls with URL, status, duration and token. | "Requests shows every authenticated call and the token that carried it." | Request-to-token correlation. |
| 34.8–37.6 | 4 · Failures | Click *4xx* at a gentle 1.2× zoom: two 401s from `billing.example.test` and one 403. | "Filter to failures, and the culprit stands out:" | Status filtering for debugging. |
| 37.6–43.1 | 4 · Culprit | Click `access_token #4` on a 401 row. The Overview opens it: **Expired 6m ago**, with its timeline showing the expiry *before* both 401s. | "an expired token behind every 401." | From a failed call to its root cause in one click. |
| 43.1–45.5 | **5 · Timeline** | Click *Timeline*: 24 events, newest first, each labelled OBSERVED or CLAIM. | "The Timeline puts every event in order:" | A chronological stream across tokens. |
| 45.5–50.3 | 5 · Claim events | A real wheel scroll reaches the claim-derived Issued (iat) and Expired (exp) events. | "observed requests, plus issue and expiry times from each token's claims." | Observed vs claim-derived events, kept apart. |
| 50.4–59.1 | **6 · Close** | Lockup, "Inspect locally. Understand instantly.", the chips *Decoded locally · No extension permissions · Nothing leaves your browser*, the CTA *Available on the Chrome Web Store*, and *Free · Open source (MIT) · github.com/behrouz-rad/TokenLens*. Fades to black. | "Everything stays in your browser. TokenLens: inspect locally, understand instantly. Free on the Chrome Web Store." | Privacy posture and call to action. |

## Direction notes

- One idea per beat. Every line states a benefit, never what the cursor does.
- Zooms follow the action and are capped at 1.75×. Wide shots are kept where the result
  appears away from the click (tab switches, section changes, the burst of traffic). Failures
  are framed at 1.2× so URL, status and token stay together.
- Highlights dim the rest of the UI instead of drawing arrows, which suits a dense DevTools
  surface.
- The cursor is drawn by Screenplay. The real pointer follows the same path, so hover states in
  the footage match it.
- Captions are always on, because store pages and social feeds autoplay muted. Each fits on one
  line.
- Sound: the narration (Kokoro, `af_heart`) over an original synthesized pad that ducks under
  the voice. The mix is normalised to −16 LUFS with a −1.5 dBFS true peak.
