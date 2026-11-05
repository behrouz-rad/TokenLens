/**
 * An original ambient pad for the video, synthesized here so no third-party music licence is
 * involved: four slow, cross-faded chords in D major built from soft, slightly detuned sines.
 * It sits well under the narration (and is ducked further by it in the mix).
 */
import { writeFileSync } from 'node:fs';

const RATE = 48000;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
/** Dmaj9, Bm11, Gmaj9, Asus2: lowest note is the bass. */
const CHORDS = [
  [38, 45, 54, 61, 64],
  [35, 42, 50, 57, 64],
  [31, 38, 47, 54, 57],
  [33, 40, 47, 54, 61],
];
const CHORD_S = 6.5;
const XFADE_S = 2.2;

export function writeMusic(file, seconds) {
  const n = Math.ceil(seconds * RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const total = Math.ceil(seconds / CHORD_S) + 1;
  for (let c = 0; c < total; c++) {
    const chord = CHORDS[c % CHORDS.length];
    const start = c * CHORD_S - XFADE_S / 2;
    const end = start + CHORD_S + XFADE_S;
    const i0 = Math.max(0, Math.floor(start * RATE));
    const i1 = Math.min(n, Math.ceil(end * RATE));
    chord.forEach((note, k) => {
      const bass = k === 0;
      const gain = bass ? 0.5 : 0.22 - k * 0.02;
      const detunes = bass ? [0] : [-6, 0, 6];
      detunes.forEach((cents, d) => {
        const f = midi(note) * Math.pow(2, cents / 1200);
        const pan = bass ? 0.5 : d === 0 ? 0.2 + 0.15 * k : d === 1 ? 0.5 : 0.8 - 0.15 * k;
        const phase0 = (note * 0.37 + d) % (2 * Math.PI);
        for (let i = i0; i < i1; i++) {
          const t = i / RATE;
          const u = (t - start) / (end - start);
          // Raised-cosine swell: each chord fades in and out over the cross-fade.
          const edge = XFADE_S / (end - start);
          const env = u < edge ? 0.5 - 0.5 * Math.cos((Math.PI * u) / edge) : u > 1 - edge ? 0.5 - 0.5 * Math.cos((Math.PI * (1 - u)) / edge) : 1;
          const w = 2 * Math.PI * f * t + phase0;
          const tone = Math.sin(w) + 0.18 * Math.sin(2 * w) + 0.05 * Math.sin(3 * w);
          const lfo = 1 + 0.12 * Math.sin(2 * Math.PI * (0.07 + 0.013 * k) * t + k);
          const s = (tone * gain * env * lfo) / detunes.length;
          left[i] += s * Math.cos((pan * Math.PI) / 2);
          right[i] += s * Math.sin((pan * Math.PI) / 2);
        }
      });
    });
  }
  // Fade the bed in and out with the picture, then normalise to -6 dBFS peak.
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const g = Math.min(1, t / 1.5) * Math.min(1, (seconds - t) / 2.5);
    left[i] *= g;
    right[i] *= g;
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const norm = peak > 0 ? 0.5 / peak : 1;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(left[i] * norm * 32767), i * 4);
    data.writeInt16LE(Math.round(right[i] * norm * 32767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}
