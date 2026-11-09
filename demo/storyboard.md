# Storyboard

Final cut: `tokenlens-demo.mp4`, 78.2 s, 1920×1080, 30 fps. Times come from the last render
(Screenplay's plan of that take). They shift by a few tenths of a second between takes, because
each step lasts as long as its narration and the real UI takes to respond. Scenes 2–6 are the real
extension in real Chrome DevTools (dark theme), filmed at 2× and edited by Screenplay. Scenes 1 and
7 are rendered from `brand/brand.html`. Cross-fades between the cards and the product footage are
0.6 s.

| Time | Scene | On screen | Narration | What it proves |
| --- | --- | --- | --- | --- |
| 0.0–6.9 | **1 · Hook** | Backdrop of indigo/violet light. The TokenLens icon draws itself (ring, lens, handle), then the wordmark, the subtitle, and a synthetic JWT split into Header · Payload · Signature. | "Meet TokenLens: JWT and Bearer token inspection, right inside Chrome DevTools." | Identity and value in the first seconds. |
| 6.3–14.8 | **2 · Capture** | DevTools opens on Elements. The cursor clicks the *TokenLens* tab, and the panel fills live as the app sends 12 requests: 6 tokens across 3 hosts. | "Open DevTools, use your app, and TokenLens collects its Bearer tokens." | Capture of the app's own traffic is automatic and lives in DevTools. |
| 14.8–20.5 | 2 · Inventory | Spotlight on the token list: Active, Expiring, No expiry, opaque Bearer. | "One record per credential, with a live status counting down to expiry." | Deduplicated inventory with temporal status. |
| 20.5–23.1 | **3 · Decode** | Click the Expiring `access_token #3`. The header, claims and payload switch to it. | "Select a token to decode it locally:" | Local decoding, per token. |
| 23.1–26.7 | 3 · Claims | The camera frames the Claims Summary (iss, sub, aud, exp, iat, jti, scope). | "claims, scopes and expiry, all in plain sight." | Readable claims and scopes. |
| 26.7–32.5 | 3 · Diagnostics | Spotlight on Diagnostics: *Signature present, not verified*, algorithm, exp/nbf/iat checks, audience *not checked*. | "Diagnostics check expiry and key claims, and say what was not verified." | Honest diagnostics; no claim of verification. |
| 32.5–36.8 | **4 · Requests** | Wide shot of Requests: exactly 12 calls with URL, status, duration and token. | "Requests lists every Bearer-authenticated call and the token it used." | Request-to-token correlation. |
| 36.8–42.0 | 4 · Failures | Click *4xx* at a gentle 1.2× zoom: two 401s from `billing.example.test` and one 403. Then click `access_token #4` on a 401 row. | "Filter failed requests, then inspect the token they used." | Status filtering, then one click to the token a request carried. |
| 42.0–46.5 | 4 · Expired | The Overview shows `access_token #4`: **Expired 6m ago**, with its timeline showing the expiry *before* both 401s. | "Here, both 401s used an expired token." | An observation from the traffic, not a claim about why the server refused it. |
| 46.5–48.9 | **5 · Timeline** | Click *Timeline*: 24 events, newest first, each labelled OBSERVED or CLAIM. | "The Timeline puts every event in order:" | A chronological stream across tokens. |
| 48.9–53.7 | 5 · Claim events | A real wheel scroll reaches the claim-derived Issued (iat) and Expired (exp) events. | "observed requests, plus issue and expiry times from each token's claims." | Observed vs claim-derived events, kept apart. |
| 53.7–56.9 | **6 · Decoder** | Click *Decoder*: the empty state, "Paste a JWT to inspect its header and payload. Decoded locally. Signature not verified." | "Got a token from elsewhere? Paste it into the Decoder." | Manual decoding works without captured traffic. |
| 56.9–59.9 | 6 · Paste | Wide shot. The cursor clicks the token field and a synthetic JWT the app never sent arrives in one paste; after the real debounce the Header and Payload appear beside it (`iss` `https://id.example.test`, `sub` `synthetic-user-42`, `scope`, `iat`/`nbf`/`exp`, nested `tenant`). | "It decodes on the spot, with no network request." | Input and decoded result side by side; decoding is local. |
| 59.9–64.1 | 6 · Facts | 1.5× zoom and spotlight on the summary: *JWT · Active · Expires in 59m*, algorithm, *Signature present, not verified*, issuer, audience, subject. | "Claims at a glance, signature not verified." | Readable claims and truthful signature wording. |
| 64.1–67.3 | 6 · Raw | At 1.25×, click *Raw* on the Payload: the exact encoded JSON replaces the formatted view. | "Inspect header and payload, switch to raw JSON," | Pretty and exact Raw views of the decoded segments. |
| 67.3–69.4 | 6 · Copy | Wide shot. Click the Payload's *Copy* button; the real toast "Raw payload JSON copied" appears. The capture counts are unchanged (checked by the recorder after filming). | "and copy what you need." | Explicit copy with feedback; the Decoder leaves the capture session alone. |
| 69.5–78.2 | **7 · Close** | Lockup, "Inspect locally. Understand instantly.", the chips *Decoded locally · No extension permissions · Nothing leaves your browser*, the CTA *Available on the Chrome Web Store*, and *Free · Open source (MIT) · github.com/behrouz-rad/TokenLens*. Fades to black. | "Everything stays in your browser. TokenLens: inspect locally, understand instantly. Free on the Chrome Web Store." | Privacy posture and call to action. |

## Direction notes

- One idea per beat. Every line states a benefit, never what the cursor does.
- Zooms follow the action and are capped at 1.75×. Wide shots are kept where the result
  appears away from the click (tab switches, section changes, the burst of traffic, the paste).
  Failures are framed at 1.2× so URL, status and token stay together. In the Decoder the summary
  card spans the whole result column, so its spotlight zooms to 1.5× to keep the text readable,
  and the small Raw toggle gets 1.25×.
- Highlights dim the rest of the UI instead of drawing arrows, which suits a dense DevTools
  surface.
- The cursor is drawn by Screenplay. The real pointer follows the same path, so hover states in
  the footage match it. The paste is one native text insertion, never typed letter by letter.
- Captions are always on, because store pages and social feeds autoplay muted. Each fits on one
  line; Screenplay moves a caption to the top when the cursor is low in the frame.
- Sound: the narration (Kokoro, `af_heart`) over an original synthesized pad that ducks under
  the voice. The mix is normalised to −16 LUFS with a −1.5 dBFS true peak.
