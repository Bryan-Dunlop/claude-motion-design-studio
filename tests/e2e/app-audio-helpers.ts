// Audio test helpers: generate test sounds with ffmpeg and measure exported audio (RMS per time window).
import { execFileSync } from 'node:child_process';

/**
 * Write a WAV made by an ffmpeg aevalsrc expression of t, e.g. `0.5*sin(2*PI*440*t)` (amplitude 0.5 → RMS 0.354).
 * `channels` 2 duplicates the signal on both channels.
 */
export function makeWav(file: string, opts: { expr: string; seconds: number; rate?: number; channels?: 1 | 2 }) {
  const rate = opts.rate ?? 44100;
  const expr = opts.channels === 2 ? `${opts.expr}|${opts.expr}` : opts.expr;
  // Quoted so commas in the expression (if(lt(t,1),0,…)) aren't read as filter separators.
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=${rate}:d=${opts.seconds}`, '-c:a', 'pcm_s16le', file]);
  return file;
}

/**
 * Left channel of the first audio stream as float samples at 48 kHz — what is really in the file (a `-ac 1` downmix
 * would sum identical channels at +3 dB, so stereo and mono sources wouldn't compare).
 */
export function decodeLeft(file: string): Float32Array {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-f', 'f32le', '-ar', '48000', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/** RMS of samples in [a, b) seconds. */
export function rms(samples: Float32Array, a: number, b: number): number {
  const i0 = Math.round(a * 48000);
  const i1 = Math.min(samples.length, Math.round(b * 48000));
  let q = 0;
  for (let i = i0; i < i1; i++) q += samples[i] * samples[i];
  return i1 > i0 ? Math.sqrt(q / (i1 - i0)) : NaN;
}

export interface StreamInfo {
  codec_type: string;
  codec_name: string;
  start_time: string;
  duration: string;
  sample_rate?: string;
  channels?: number;
}

/** Every stream of a media file with its start time and duration (container timestamps, edit lists applied). */
export function streams(file: string): StreamInfo[] {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,start_time,duration,sample_rate,channels', '-of', 'json', file]).toString();
  return JSON.parse(out).streams;
}
