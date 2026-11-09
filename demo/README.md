# TokenLens promotional video

`tokenlens-demo.mp4` is a 1920×1080, 30 fps product introduction for the Chrome Web Store listing, the
README and social posts. Everything in it is reproducible from this folder with one command.

- [`storyboard.md`](storyboard.md): scenes, timing and what each one proves
- [`narration.md`](narration.md): the voice-over script
- [`scenes.mjs`](scenes.mjs): the single source of truth (narration lines and recorded steps)

## What is real

The product footage is the **built extension running inside real Chrome DevTools**. It is not
the standalone development panel and not a mock-up. [`record.spec.ts`](record.spec.ts) reuses the
raw CDP client from `e2e/support/devtools.ts`. It opens an undocked DevTools window on a synthetic
app, clicks the real *TokenLens* tab, and drives the panel with real mouse, wheel and text input.
It films the DevTools window with `Page.startScreencast`, so only that window is captured: no
desktop, notifications or other applications can appear.

The traffic is synthetic. [`fixture/app.html`](fixture/app.html) generates JWTs with a placeholder
signature, and [`fixture/server.mjs`](fixture/server.mjs) answers for `*.example.test`. Those names
are reserved (RFC 2606), and Chromium maps them to the local server. No real credential, user or
service is involved.

## Regenerate

Requirements: Node 22.12+, the repository's dependencies (`npm ci` in the root),
`npx playwright install chromium`, a desktop session, and a display of at least 2600×1500
physical pixels. The DevTools window is 1280×720 CSS pixels at a forced 2× scale.

```bash
cd demo
npm ci                      # Screenplay (video editing) and Kokoro (narration); local to demo/
npm run video               # builds dist/, narrates, records, edits, assembles
```

`npm run video -- --skip-build` reuses `dist/`. `-- --skip-record` re-edits the last take, which
is enough after changing captions, narration wording (same length), style or music.
`-- --no-music` leaves out the music bed. The first run downloads the Kokoro (~330 MB) and
Whisper models into `demo/node_modules`. A full run takes about 6 minutes.

Leave the DevTools window alone while it records. Covering it is fine; clicking into it is not.

| Stage | Script | Output (in `work/`, git-ignored) |
| --- | --- | --- |
| Narration (Kokoro-82M, voice `af_heart`) | `scripts/narrate.mjs` (`--verify` transcribes every clip with Whisper) | `narration/*.wav`, `manifest.json` |
| Scenario and directions | `scripts/scenario.mjs` | `tokenlens-demo.json`, `directions.json` |
| Rehearsal (`DEMO_CHECK=1`) and take | `record.spec.ts` via `playwright.config.ts` | `check/*.png`, `.screenplay/takes/…` |
| Brand cards and backdrop | `scripts/brand.mjs` + `brand/brand.html` | `brand/intro.mp4`, `outro.mp4`, `background.png` |
| Edit (cursor, zooms, highlights, captions) | `scripts/edit.mjs` → `screenplay render` | `main.mp4`, `main.storyboard.png` |
| Final cut and mix | `scripts/assemble.mjs` (+ `scripts/music.mjs`) | `../tokenlens-demo.mp4` |
| Quality check (manual) | `npm run inspect` | stream facts, loudness, `review/contact-sheet.png` |
| Step validation | `npm test` (`scripts/scenario.test.mjs`) | recorder-only fields stripped, strict Screenplay schema |

## How it fits together

Screenplay's own `record` command films a page in a fresh headless browser, and that browser
cannot host DevTools or extension panels. So `record.spec.ts` writes a Screenplay *take*
(frames plus a timeline of every action and element box) using Screenplay's own pacing and cursor
path. `screenplay render` then edits it exactly as it would edit its own recording.
`scenes.mjs` generates both the strict Screenplay scenario and the recorder's directions, so they
cannot drift apart.

## Checks on every take

The recorder rejects a take, and the build films again (up to twelve takes), when the footage
would misstate what TokenLens does:

- The Requests list must hold exactly the 12 Bearer requests the synthetic app sends, right after
  the burst and again at the end of the take. A rejected take fails within its first step, so a
  reshoot costs about 20 s.
- Steps with `expect` wait for the real UI to show the result (for example *JWT decoded ·
  signature not verified* after the paste) and fail if it never appears.
- After filming, the recorder opens the Overview off camera and checks that the token and request
  counts are exactly what they were before the Decoder scene: pasting a token never adds to the
  capture session.
- Any runtime error in the panel rejects the take.

The token pasted into the Decoder comes from `acmeDemo.sample('decoder')` in
[`fixture/app.html`](fixture/app.html). The page never sends it, and its times are relative to the
page load. The recorder clicks the field and inserts the whole token with one CDP
`Input.insertText` call, the way a paste arrives; nothing in the panel is set directly.

## Audio

- Voice: [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) through
  `kokoro-js`, run locally on the CPU. No account or key is needed.
- Music: an original ambient pad synthesized by `scripts/music.mjs`, so no third-party licence is
  involved. It is ducked under the voice, and the mix is normalised to −16 LUFS.

## Notes

- `npm audit` in `demo/` reports `sharp` advisories through `@huggingface/transformers`. That code
  path handles images, which this tool never processes. These dependencies are not part of the
  extension, its build or its CI.
- The video's claims follow the product's wording rules. Tokens are *decoded*, signatures are
  *present, not verified*, and nothing claims verification.
