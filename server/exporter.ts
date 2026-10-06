// MP4 export: headless Chromium renders frames with the same renderFrame used by the editor, at the output size
// (exportSize), posts raw RGBA bytes back here, and we pipe them straight into ffmpeg (libx264, yuv420p; CRF/preset
// from the export options, CRF 16 by default).
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { ExportOptionsSchema, exportSize, type ExportOptions, type ExportOptionsInput } from '../src/shared/exportSize';
import { frameCount } from '../src/shared/renderFrame';
import type { Asset, Project } from '../src/shared/schema';
import { buildAudioArgs, type AudioArgs } from './audioMix';
import { safeJoin } from './projects';

export type JobStatus = 'starting' | 'rendering' | 'encoding' | 'done' | 'error' | 'cancelled';

export interface ExportJob {
  id: string;
  project: Project;
  projectDir: string | null;
  outFile: string;
  options: ExportOptions;
  /** Output frame size (even numbers) and the renderFrame scale that fills it (exportSize). */
  size: { outW: number; outH: number; scale: number };
  status: JobStatus;
  frame: number;
  total: number;
  error?: string;
  /** Problems that didn't stop the export (e.g. a missing audio file); shown in the export dialog. */
  warnings: string[];
  ffmpeg?: ChildProcessWithoutNullStreams;
  /** Kills ffmpeg if it doesn't exit after its input ended (see finishFrames). */
  watchdog?: ReturnType<typeof setTimeout>;
  browser?: Browser;
  finished: Promise<void>;
  /** Internal: called by the frame endpoint / page. */
  resolve: () => void;
  reject: (e: Error) => void;
}

export const FFMPEG_HELP = [
  'ffmpeg was not found on your PATH, so the MP4 cannot be encoded.',
  'Install it, then restart `npm run dev`:',
  '  Windows:  winget install --id Gyan.FFmpeg   (then open a NEW terminal)',
  '  macOS:    brew install ffmpeg',
  '  Linux:    sudo apt install ffmpeg',
  'Check with:  ffmpeg -version',
].join('\n');

export function ffmpegAvailable(): boolean {
  const bin = process.env.FFMPEG_PATH || 'ffmpeg';
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return r.status === 0;
}

const jobs = new Map<string, ExportJob>();
export const getJob = (id: string) => jobs.get(id);

const NO_AUDIO: AudioArgs = { inputs: [], filter: [], codec: [], warnings: [] };

/**
 * Full ffmpeg command: raw RGBA frames at the output size on stdin (input 0), plus the audio inputs and mix from
 * buildAudioArgs. `options` (export options, all optional) set the size, CRF and preset.
 */
export function ffmpegArgs(project: Project, outFile: string, audio: AudioArgs = NO_AUDIO, options: ExportOptionsInput = {}): string[] {
  const o = ExportOptionsSchema.parse(options);
  const { outW, outH } = exportSize(project.settings, o.scale);
  return [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${outW}x${outH}`, '-r', String(project.settings.fps), '-i', '-',
    ...audio.inputs,
    ...audio.filter,
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p',
    '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...audio.codec,
    '-movflags', '+faststart',
    outFile,
  ];
}

/** An asset's file inside the project folder (used when the caller doesn't pass a resolver). */
function fileInProject(projectDir: string | null, asset: Asset): string | null {
  if (!projectDir) return null;
  try {
    const file = safeJoin(projectDir, asset.relativePath);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/**
 * Start an export. `baseUrl` is the running server (which serves render.html).
 * Resolves the job object immediately; await job.finished for completion.
 */
export async function startExport(opts: {
  project: Project;
  projectDir: string | null;
  outFile: string;
  baseUrl: string;
  /** Where an asset's bytes are on disk (project folder, then the scratch store); null when missing. */
  resolveAsset?: (asset: Asset) => string | null;
  /** Size, quality and audio (all optional; defaults = 100%, CRF 16 medium, with audio). */
  options?: ExportOptionsInput;
}): Promise<ExportJob> {
  if (!ffmpegAvailable()) throw Object.assign(new Error(FFMPEG_HELP), { status: 424 });
  const options = ExportOptionsSchema.parse(opts.options ?? {});
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const finished = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  finished.catch(() => undefined);
  const job: ExportJob = {
    id: crypto.randomUUID(),
    project: opts.project,
    projectDir: opts.projectDir,
    outFile: opts.outFile,
    options,
    size: exportSize(opts.project.settings, options.scale),
    status: 'starting',
    frame: 0,
    total: frameCount(opts.project),
    warnings: [],
    finished,
    resolve,
    reject,
  };
  jobs.set(job.id, job);

  // "Include audio" off: no audio inputs at all (and no warnings about missing sound files).
  const audio = options.audio ? buildAudioArgs(opts.project, opts.resolveAsset ?? ((a) => fileInProject(opts.projectDir, a))) : NO_AUDIO;
  job.warnings = audio.warnings;
  const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ffmpegArgs(opts.project, opts.outFile, audio, options));
  job.ffmpeg = ff;
  let ffErr = '';
  ff.stderr.on('data', (d) => (ffErr += d.toString()));
  ff.stdin.on('error', () => undefined);
  ff.on('close', (code) => {
    clearTimeout(job.watchdog);
    if (job.status === 'cancelled') return;
    if (code === 0 && job.status === 'encoding') {
      job.status = 'done';
      cleanup(job);
      resolve();
    } else if (job.status !== 'done') {
      fail(job, `ffmpeg exited with code ${code}: ${ffErr.trim()}`);
    }
  });

  (async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--force-color-profile=srgb', '--disable-gpu'],
    });
    job.browser = browser;
    if (isFinal(job)) return cleanup(job);
    const page = await browser.newPage();
    page.on('pageerror', (e) => fail(job, `Render page error: ${e.message}`));
    job.status = 'rendering';
    await page.goto(`${opts.baseUrl}/render.html?job=${job.id}`);
  })().catch((e: Error) => fail(job, `Could not start headless Chromium: ${e.message}. Try: npx playwright install chromium`));

  return job;
}

function isFinal(job: ExportJob) {
  return job.status === 'done' || job.status === 'error' || job.status === 'cancelled';
}

/**
 * Is a running export writing `file`? ffmpeg only creates its output after the first frames arrive, so a file that
 * doesn't exist yet can still be taken. Compared case-insensitively: on Windows and macOS that is the same file.
 */
export function isExportTarget(file: string): boolean {
  const key = path.resolve(file).toLowerCase();
  for (const job of jobs.values()) if (!isFinal(job) && path.resolve(job.outFile).toLowerCase() === key) return true;
  return false;
}

/** The first `dir/fileName(n)` (n = 1, 2, …) that is neither on disk nor being written by a running export. */
export function freeOutFile(dir: string, fileName: (n: number) => string, inUse: (file: string) => boolean = isExportTarget): string {
  for (let n = 1; ; n++) {
    const file = path.join(dir, fileName(n));
    if (!fs.existsSync(file) && !inUse(file)) return file;
  }
}

/** Called for each frame POSTed by the render page, in order. Applies backpressure. */
export async function acceptFrame(job: ExportJob, index: number, bytes: Buffer): Promise<void> {
  if (isFinal(job)) throw new Error(`Job is ${job.status}`);
  const { outW, outH } = job.size;
  if (index !== job.frame) throw new Error(`Expected frame ${job.frame}, got ${index}`);
  if (bytes.length !== outW * outH * 4) throw new Error(`Frame ${index} has ${bytes.length} bytes, expected ${outW * outH * 4} (${outW}×${outH})`);
  const ff = job.ffmpeg!;
  if (!ff.stdin.write(bytes)) await new Promise<void>((r) => ff.stdin.once('drain', () => r()));
  job.frame = index + 1;
}

/** How long ffmpeg may take to exit after its input ended (MOTION_FFMPEG_EXIT_TIMEOUT_MS overrides it for tests). */
export const FFMPEG_EXIT_TIMEOUT_MS = 30_000;

export function finishFrames(job: ExportJob) {
  if (isFinal(job)) return;
  if (job.frame !== job.total) return fail(job, `Render page stopped at frame ${job.frame}/${job.total}`);
  job.status = 'encoding';
  job.ffmpeg?.stdin.end();
  job.browser?.close().catch(() => undefined);
  // Watchdog: a stuck ffmpeg ignores SIGTERM, so after the timeout it is SIGKILLed (by fail → cleanup) and the job fails.
  const ms = Number(process.env.MOTION_FFMPEG_EXIT_TIMEOUT_MS) || FFMPEG_EXIT_TIMEOUT_MS;
  job.watchdog = setTimeout(() => {
    if (job.status === 'encoding') fail(job, `ffmpeg did not finish within ${ms / 1000} s after the last frame, so it was stopped. Please try the export again.`);
  }, ms);
}

export function fail(job: ExportJob, message: string) {
  if (isFinal(job)) return;
  job.status = 'error';
  job.error = message;
  cleanup(job, true);
  job.reject(new Error(message));
}

export function cancel(job: ExportJob) {
  if (isFinal(job)) return;
  job.status = 'cancelled';
  cleanup(job, true);
  job.reject(new Error('Export cancelled'));
}

function cleanup(job: ExportJob, removeOutput = false) {
  clearTimeout(job.watchdog);
  job.browser?.close().catch(() => undefined);
  if (removeOutput) {
    job.ffmpeg?.kill('SIGKILL');
    job.ffmpeg?.once('close', () => removeQuietly(job.outFile));
  }
}

export function publicJob(job: ExportJob) {
  return {
    id: job.id,
    status: job.status,
    frame: job.frame,
    total: job.total,
    error: job.error,
    warnings: job.warnings,
    outFile: job.outFile,
    width: job.size.outW,
    height: job.size.outH,
    options: job.options,
  };
}

/** Delete a file, retrying briefly if Windows still has it locked; never throws (it runs in event callbacks). */
function removeQuietly(file: string, attempt = 0) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    if (attempt < 5) setTimeout(() => removeQuietly(file, attempt + 1), 100);
  }
}
