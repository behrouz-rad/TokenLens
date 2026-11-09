/**
 * Single source of truth for the TokenLens promotional video.
 *
 * LINES is the narration: `caption` is what viewers read, `spoken` what the voice says (written
 * for pronunciation, e.g. "four-oh-one"). Captions stay on one line (about 72 characters).
 * STEPS drive the real DevTools recording and become the Screenplay scenario that edits it.
 * Recorder-only fields are stripped from that scenario:
 *   scene   storyboard grouping
 *   line    narration key in LINES (becomes `say` + `audio`)
 *   play    synthetic traffic burst the demo page sends right after the step's action
 *   wheel   pixels a `scroll` step scrolls its target by, with the real mouse wheel
 *   paste   sample token from the demo page that a `click` step inserts into the field it just
 *           focused, in one native text insertion (like a paste, not typed letter by letter)
 *   expect  [{ in, text }]: after the action, the take waits until each target's text contains
 *           `text`, and is rejected if it never does
 * Targets use Screenplay's syntax; `devtools:tab=<name>` addresses the DevTools tab strip and
 * `a >> b` narrows `b` to elements inside `a` (`has=` filters by text, `nth=` picks one).
 *
 * Wording rule (CLAUDE.md §2, invariant 3): TokenLens decodes, it never verifies signatures.
 * Capture claims stay observational: TokenLens lists what DevTools saw, it does not explain why a
 * server answered the way it did.
 */

export const VOICE = {
  model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype: 'fp32',
  voice: 'af_heart',
  speed: 1.1,
};

/** DevTools frontend viewport in CSS pixels; captured at 2x. */
export const VIEWPORT = { width: 1280, height: 720, scale: 2 };

export const LINES = {
  intro: {
    caption: 'Meet TokenLens: JWT and Bearer token inspection, right inside Chrome DevTools.',
    spoken: 'Meet TokenLens: J.W.T. and Bearer token inspection, right inside Chrome DevTools.',
  },
  capture: {
    caption: 'Open DevTools, use your app, and TokenLens collects its Bearer tokens.',
  },
  inventory: {
    caption: 'One record per credential, with a live status counting down to expiry.',
  },
  decode: {
    caption: 'Select a token to decode it locally:',
  },
  claims: {
    caption: 'claims, scopes and expiry, all in plain sight.',
  },
  diagnostics: {
    caption: 'Diagnostics check expiry and key claims, and say what was not verified.',
  },
  requests: {
    caption: 'Requests lists every Bearer-authenticated call and the token it used.',
    spoken: 'Requests lists every Bearer-authenticated call, and the token it used.',
  },
  failures: {
    caption: 'Filter failed requests, then inspect the token they used.',
  },
  expired: {
    caption: 'Here, both 401s used an expired token.',
    spoken: 'Here, both four-oh-ones used an expired token.',
  },
  timeline: {
    caption: 'The Timeline puts every event in order:',
  },
  claimEvents: {
    caption: "observed requests, plus issue and expiry times from each token's claims.",
  },
  decoderOpen: {
    caption: 'Got a token from elsewhere? Paste it into the Decoder.',
  },
  decoderPaste: {
    caption: 'It decodes on the spot, with no network request.',
  },
  decoderFacts: {
    caption: 'Claims at a glance, signature not verified.',
  },
  decoderRaw: {
    caption: 'Inspect header and payload, switch to raw JSON,',
  },
  decoderCopy: {
    caption: 'and copy what you need.',
  },
  outro: {
    caption: 'Everything stays in your browser. TokenLens: inspect locally, understand instantly. Free on the Chrome Web Store.',
  },
};

const NAV = "css=nav[aria-label='Main sections']";

export const STEPS = [
  // Scene 2: automatic capture
  { scene: 'capture', click: 'devtools:tab=TokenLens', zoom: false, line: 'capture', play: 'initial' },
  { scene: 'capture', highlight: "role=listbox[name='Captured tokens']", line: 'inventory', duration: 1.5 },

  // Scene 3: decode. #1 is selected automatically, so the story opens the expiring #3.
  { scene: 'decode', click: 'testid=token-item >> has=access_token #3', line: 'decode' },
  { scene: 'decode', zoomTo: 'testid=claims-summary', line: 'claims', duration: 1.5 },
  { scene: 'decode', highlight: 'testid=diagnostics-panel', line: 'diagnostics', duration: 1.5 },

  // Scene 4: requests, from the failures to the token they used. A gentle zoom keeps whole
  // rows (URL, status and token) in frame.
  { scene: 'requests', click: `${NAV} >> text=Requests`, zoom: false, line: 'requests', hold: 0.4 },
  { scene: 'requests', click: "css=[aria-label='Filter by HTTP status'] >> text=4xx", zoom: 1.2, line: 'failures' },
  { scene: 'requests', click: "role=button[name='Show access_token #4 in Overview'] >> nth=0", zoom: 1.2, hold: 0.2 },
  { scene: 'requests', highlight: 'testid=token-header', line: 'expired', duration: 1.5 },

  // Scene 5: timeline. The scroll reaches the oldest events, where the claim-derived
  // Issued / Expired entries sit beside the observed ones.
  { scene: 'timeline', click: `${NAV} >> text=Timeline`, zoom: false, line: 'timeline' },
  { scene: 'timeline', scroll: "css=[aria-label='Timeline events (scrollable)']", wheel: 900, zoom: false, line: 'claimEvents', hold: 0.6 },

  // Scene 6: Decoder. A token the app never sent is pasted in; the captured session is left as it
  // was (the recorder checks that after filming). Wide shots keep the input and the decoded
  // result in frame together; the summary and the small Raw toggle get gentle zooms.
  {
    scene: 'decoder', click: `${NAV} >> text=Decoder`, zoom: false, line: 'decoderOpen',
    expect: [{ in: 'testid=decoder-output', text: 'Paste a JWT to inspect its header and payload.' }],
  },
  {
    scene: 'decoder', click: 'testid=decoder-input', paste: 'decoder', zoom: false, line: 'decoderPaste', hold: 0.3,
    expect: [
      { in: 'testid=status-decoder-state', text: 'JWT decoded · signature not verified' },
      { in: 'testid=decoder-facts', text: 'Signature present, not verified' },
      { in: 'testid=decoder-facts', text: 'https://id.example.test' },
      { in: 'testid=decoded-payload', text: 'synthetic-user-42' },
      { in: 'testid=decoded-payload', text: 'tenant_demo' },
    ],
  },
  // The summary card spans the result column, so the spotlight zooms in to make its text readable.
  { scene: 'decoder', highlight: 'testid=decoder-summary', zoom: 1.5, line: 'decoderFacts', duration: 1.2 },
  {
    scene: 'decoder', click: "css=[aria-label='Payload display mode'] >> text=Raw", zoom: 1.25, line: 'decoderRaw',
    expect: [{ in: 'testid=decoded-payload-raw', text: '"sub":"synthetic-user-42"' }],
  },
  {
    scene: 'decoder', click: "role=button[name='Copy payload JSON']", zoom: false, line: 'decoderCopy', hold: 0.5,
    expect: [{ in: 'css=[data-sonner-toast]', text: 'Raw payload JSON copied' }],
  },
];

/** Branded cards rendered around the Screenplay edit (demo/brand/). */
export const CARDS = {
  intro: { line: 'intro', minSeconds: 5.6 },
  outro: { line: 'outro', minSeconds: 7.5 },
};
