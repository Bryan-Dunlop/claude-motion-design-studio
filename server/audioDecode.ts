// Fallback for audio the browser can't decode (Playwright's Chromium has no AAC decoder, for example): decode with
// ffmpeg to 8 kHz mono and return the length and waveform peaks. The length comes from the decoded sample count —
// ffprobe's container duration is wrong for ADTS and some MP3 files.
import { spawn } from 'node:child_process';

const RATE = 8000;
export const PEAKS_PER_SECOND = 100;

export interface AudioInfo {
  /** Seconds. */
  duration: number;
  /** Max |sample| per 1/peaksPerSecond s, 0..1 (3 decimals). */
  peaks: number[];
  peaksPerSecond: number;
}

export function decodeAudioInfo(file: string): Promise<AudioInfo> {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-']);
    const perBucket = RATE / PEAKS_PER_SECOND;
    const peaks: number[] = [];
    let samples = 0;
    let inBucket = 0;
    let max = 0;
    let rest: Buffer = Buffer.alloc(0);
    let err = '';
    const push = () => {
      peaks.push(Math.round(Math.min(1, max) * 1000) / 1000);
      max = 0;
      inBucket = 0;
    };
    ff.stdout.on('data', (chunk: Buffer) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const n = Math.floor(buf.length / 4);
      for (let i = 0; i < n; i++) {
        const v = Math.abs(buf.readFloatLE(i * 4));
        if (v > max) max = v;
        if (++inBucket === perBucket) push();
      }
      samples += n;
      rest = buf.subarray(n * 4);
    });
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0 || samples === 0) return reject(new Error(err.trim().split('\n').pop() || 'no audio stream'));
      if (inBucket > 0) push();
      resolve({ duration: samples / RATE, peaks, peaksPerSecond: PEAKS_PER_SECOND });
    });
  });
}
