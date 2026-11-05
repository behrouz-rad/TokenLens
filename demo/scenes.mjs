/**
 * Single source of truth for the TokenLens promotional video.
 *
 * LINES is the narration: `caption` is what viewers read, `spoken` what the voice says (written
 * for pronunciation, e.g. "four-oh-one"). Captions stay on one line (about 72 characters).
 * STEPS drive the real DevTools recording and become the Screenplay scenario that edits it.
 * Recorder-only fields are stripped from that scenario:
 *   scene  storyboard grouping
 *   line   narration key in LINES (becomes `say` + `audio`)
 *   play   synthetic traffic burst the demo page sends right after the step's action
 *   wheel  pixels a `scroll` step scrolls its target by, with the real mouse wheel
 * Targets use Screenplay's syntax; `devtools:tab=<name>` addresses the DevTools tab strip and
 * `a >> b` narrows `b` to elements inside `a` (`has=` filters by text, `nth=` picks one).
 *
 * Wording rule (CLAUDE.md §2, invariant 3): TokenLens decodes, it never verifies signatures.
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
    caption: 'Open DevTools, use your app, and TokenLens catches every Bearer token.',
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
    caption: 'Requests shows every authenticated call and the token that carried it.',
  },
  failures: {
    caption: 'Filter to failures, and the culprit stands out:',
  },
  culprit: {
    caption: 'an expired token behind every 401.',
    spoken: 'an expired token, behind every four-oh-one.',
  },
  timeline: {
    caption: 'The Timeline puts every event in order:',
  },
  claimEvents: {
    caption: "observed requests, plus issue and expiry times from each token's claims.",
  },
  outro: {
    caption: 'Everything stays in your browser. TokenLens: inspect locally, understand instantly. Free on the Chrome Web Store.',
  },
};

export const STEPS = [
  // Scene 2: automatic capture
  { scene: 'capture', click: 'devtools:tab=TokenLens', zoom: false, line: 'capture', play: 'initial' },
  { scene: 'capture', highlight: "role=listbox[name='Captured tokens']", line: 'inventory', duration: 1.5 },

  // Scene 3: decode. #1 is selected automatically, so the story opens the expiring #3.
  { scene: 'decode', click: 'testid=token-item >> has=access_token #3', line: 'decode' },
  { scene: 'decode', zoomTo: 'testid=claims-summary', line: 'claims', duration: 1.5 },
  { scene: 'decode', highlight: 'testid=diagnostics-panel', line: 'diagnostics', duration: 1.5 },

  // Scene 4: requests, from the failures to the token behind them. A gentle zoom keeps whole
  // rows (URL, status and token) in frame.
  { scene: 'requests', click: "css=nav[aria-label='Main sections'] >> text=Requests", zoom: false, line: 'requests', hold: 0.4 },
  { scene: 'requests', click: "css=[aria-label='Filter by HTTP status'] >> text=4xx", zoom: 1.2, line: 'failures' },
  { scene: 'requests', click: "role=button[name='Show access_token #4 in Overview'] >> nth=0", zoom: 1.2, hold: 0.2 },
  { scene: 'requests', highlight: 'testid=token-header', line: 'culprit', duration: 1.5 },

  // Scene 5: timeline. The scroll reaches the oldest events, where the claim-derived
  // Issued / Expired entries sit beside the observed ones.
  { scene: 'timeline', click: "css=nav[aria-label='Main sections'] >> text=Timeline", zoom: false, line: 'timeline' },
  { scene: 'timeline', scroll: "css=[aria-label='Timeline events (scrollable)']", wheel: 900, zoom: false, line: 'claimEvents', hold: 0.6 },
];

/** Branded cards rendered around the Screenplay edit (demo/brand/). */
export const CARDS = {
  intro: { line: 'intro', minSeconds: 5.6 },
  outro: { line: 'outro', minSeconds: 7.5 },
};
