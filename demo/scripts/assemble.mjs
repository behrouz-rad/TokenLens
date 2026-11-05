/**
 * Final cut: intro card → Screenplay edit of the real DevTools take → outro card, with
 * cross-fades, the card narration, the music bed ducked under the voice, loudness normalised
 * to -16 LUFS, BT.709-tagged H.264 at 1920x1080, 30 fps.  Output: demo/tokenlens-demo.mp4
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CARDS } from '../scenes.mjs';
import { CARD_TIMING, cardDuration } from './brand.mjs';
import { writeMusic } from './music.mjs';
import { readManifest } from './scenario.mjs';
import { DEMO_DIR, FFMPEG, WORK_DIR, ffmpeg, log } from './paths.mjs';

const X = 0.6; // cross-fade length
const MUSIC_DB = -21; // bed level before ducking, relative to its -6 dBFS peak

export function mediaDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', () => {
      const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(err);
      if (!m) return reject(new Error(`cannot read the duration of ${file}`));
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

export async function assemble({ music = !process.argv.includes('--no-music') } = {}) {
  const manifest = readManifest();
  const intro = join(WORK_DIR, 'brand', 'intro.mp4');
  const main = join(WORK_DIR, 'main.mp4');
  const outro = join(WORK_DIR, 'brand', 'outro.mp4');
  const di = cardDuration('intro', manifest);
  const dout = cardDuration('outro', manifest);
  const dm = await mediaDuration(main);
  const total = di + dm + dout - 2 * X;
  const mainAt = di - X;
  const outroAt = di + dm - 2 * X;
  const out = join(DEMO_DIR, 'tokenlens-demo.mp4');

  const inputs = ['-i', intro, '-i', main, '-i', outro, '-i', manifest[CARDS.intro.line].file, '-i', manifest[CARDS.outro.line].file];
  const ms = (s) => Math.round(s * 1000);
  const fmt = 'aformat=sample_rates=48000:channel_layouts=stereo';
  const filters = [
    '[0:v]fps=30,settb=AVTB,format=yuv420p[vi]',
    '[1:v]fps=30,settb=AVTB,format=yuv420p[vm]',
    '[2:v]fps=30,settb=AVTB,format=yuv420p[vo]',
    `[vi][vm]xfade=transition=fade:duration=${X}:offset=${(di - X).toFixed(3)}[v1]`,
    `[v1][vo]xfade=transition=fade:duration=${X}:offset=${outroAt.toFixed(3)}[v2]`,
    // Every source was encoded from RGB with swscale's BT.601 default; convert once to BT.709.
    `[v2]fade=t=in:st=0:d=0.35,fade=t=out:st=${(total - 0.7).toFixed(3)}:d=0.7,scale=in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p[v]`,
    `[3:a]${fmt},adelay=${ms(CARD_TIMING.intro.voiceAt)}:all=1[a_in]`,
    `[1:a]${fmt},adelay=${ms(mainAt)}:all=1[a_main]`,
    `[4:a]${fmt},adelay=${ms(outroAt + CARD_TIMING.outro.voiceAt)}:all=1[a_out]`,
    '[a_in][a_main][a_out]amix=inputs=3:normalize=0:dropout_transition=0,apad[voice]',
  ];
  if (music) {
    const bed = join(WORK_DIR, 'music.wav');
    writeMusic(bed, total + 0.5);
    inputs.push('-i', bed);
    filters.push(
      '[voice]asplit=2[vmix][vkey]',
      `[5:a]${fmt},lowpass=f=3200,aecho=0.8:0.6:70|140|260:0.28|0.2|0.12,volume=${MUSIC_DB}dB[bed]`,
      '[bed][vkey]sidechaincompress=threshold=0.02:ratio=5:attack=40:release=600:makeup=1[ducked]',
      '[vmix][ducked]amix=inputs=2:normalize=0:dropout_transition=0[mix]'
    );
  } else {
    filters.push('[voice]anull[mix]');
  }
  filters.push(`[mix]atrim=0:${total.toFixed(3)},afade=t=out:st=${(total - 0.7).toFixed(3)}:d=0.7,loudnorm=I=-16:TP=-1.5:LRA=11,${fmt}[a]`);

  await ffmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', total.toFixed(3), '-movflags', '+faststart', out,
  ]);
  log(`wrote ${out} (${total.toFixed(2)} s: intro ${di.toFixed(2)} + main ${dm.toFixed(2)} + outro ${dout.toFixed(2)} − ${2 * X} cross-fades)`);
  return { out, total };
}

if (process.argv[1] && process.argv[1].endsWith('assemble.mjs')) await assemble();
