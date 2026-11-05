/**
 * Generates the narration with Kokoro-82M (Apache-2.0), locally, with no account or key.
 *
 *   node scripts/narrate.mjs            synthesize missing lines into work/narration/
 *   node scripts/narrate.mjs --verify   also transcribe every clip with Whisper and compare
 *
 * Clips are cached by voice settings and text, so unchanged lines are never re-synthesized.
 * work/narration/manifest.json maps each line id to its WAV file and duration; the recorder uses
 * the durations to hold each step until its sentence is finished.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LINES, VOICE } from '../scenes.mjs';
import { DEMO_DIR, log } from './paths.mjs';

const OUT = join(DEMO_DIR, 'work', 'narration');
const verify = process.argv.includes('--verify');

/** 16-bit PCM mono WAV, the most portable container for ffmpeg and Screenplay alike. */
function writeWav(file, samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

function readWav(file) {
  const buf = readFileSync(file);
  const rate = buf.readUInt32LE(24);
  const n = (buf.length - 44) / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(44 + i * 2) / 32768;
  return { samples, rate };
}

/** Trims synthesis padding so step timing follows the speech, keeping a short natural tail. */
function trimSilence(samples, rate) {
  const threshold = 0.012;
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < threshold) a++;
  while (b > a && Math.abs(samples[b]) < threshold) b--;
  return samples.slice(Math.max(0, a - Math.round(0.04 * rate)), Math.min(samples.length, b + Math.round(0.12 * rate)));
}

const spokenText = (line) => line.spoken ?? line.caption;
const keyOf = (text) => createHash('sha1').update(JSON.stringify([VOICE, text])).digest('hex').slice(0, 12);

mkdirSync(OUT, { recursive: true });
const manifest = {};
let tts;
for (const [id, line] of Object.entries(LINES)) {
  const text = spokenText(line);
  const file = join(OUT, `${id}-${keyOf(text)}.wav`);
  if (!existsSync(file)) {
    if (!tts) {
      log('Loading Kokoro (first run downloads the model, ~330 MB)…');
      const { KokoroTTS } = await import('kokoro-js');
      tts = await KokoroTTS.from_pretrained(VOICE.model, { dtype: VOICE.dtype, device: 'cpu' });
    }
    const audio = await tts.generate(text, { voice: VOICE.voice, speed: VOICE.speed });
    writeWav(file, trimSilence(audio.audio, audio.sampling_rate), audio.sampling_rate);
    log(`synthesized ${id}`);
  }
  const { samples, rate } = readWav(file);
  manifest[id] = { file, duration: samples.length / rate, caption: line.caption, spoken: text };
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
const total = Object.values(manifest).reduce((s, m) => s + m.duration, 0);
for (const [id, m] of Object.entries(manifest)) log(`${id.padEnd(12)} ${m.duration.toFixed(2)} s`);
log(`total speech ${total.toFixed(1)} s`);

if (verify) {
  const { pipeline } = await import('@huggingface/transformers');
  const asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-small.en', { dtype: 'fp32', device: 'cpu' });
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  let worst = 1;
  for (const [id, m] of Object.entries(manifest)) {
    const { samples, rate } = readWav(m.file);
    const target = 16000;
    const out = new Float32Array(Math.floor((samples.length * target) / rate));
    for (let i = 0; i < out.length; i++) {
      const x = (i * rate) / target;
      const j = Math.floor(x);
      out[i] = (samples[j] ?? 0) + ((samples[j + 1] ?? 0) - (samples[j] ?? 0)) * (x - j);
    }
    const heard = (await asr(out)).text.trim();
    const expected = new Set(words(m.caption));
    const got = new Set(words(heard));
    const recall = [...expected].filter((w) => got.has(w)).length / expected.size;
    worst = Math.min(worst, recall);
    log(`${id.padEnd(12)} ${(recall * 100).toFixed(0).padStart(3)}%  heard: ${heard}`);
  }
  log(`lowest word recall ${(worst * 100).toFixed(0)}%`);
}
