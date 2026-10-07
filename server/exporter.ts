// MP4 export: headless Chromium renders frames with the same renderFrame used by the editor, at the output size
// (exportSize), posts raw RGBA bytes back here, and we pipe them straight into ffmpeg (libx264, yuv420p; CRF/preset
// from the export options, CRF 16 by default).
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Browser } from 'playwright';
import { ExportOptionsSchema, exportSize, type ExportOptions, type ExportOptionsInput } from '../src/shared/exportSize';
import { frameCount } from '../src/shared/renderFrame';
import type { Asset, Project } from '../src/shared/schema';
import { buildAudioArgs, type AudioArgs } from './audioMix';
import { renameWithRetry, safeJoin } from './projects';

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
  /** When ffmpeg last showed progress (Date.now()): a -progress report that moved on, or a bigger output file. */
  progressAt: number;
  /** Kills ffmpeg if it stops making progress after its input ended (see watchFlush). */
  watchdog?: ReturnType<typeof setInterval>;
  /** Fails the job if no frame arrives for a while (see expectFrame). */
  stall?: ReturnType<typeof setTimeout>;
  browser?: Browser;
  finished: Promise<void>;
  /**
   * Resolves once an ended job has let go of everything: ffmpeg has exited, the partial MP4 of a failed or cancelled
   * export is deleted and Chromium is closed. The CLI waits for it before it exits.
   */
  cleanedUp: Promise<void>;
  /** Internal: called by the frame endpoint / page. */
  resolve: () => void;
  reject: (e: Error) => void;
  /** Internal: resolves on ffmpeg's 'close' event (at once when ffmpeg never started). */
  ffmpegClosed: Promise<void>;
  /**
   * Internal: where ffmpeg writes (`<outFile>.part`). It gets the real name only once the video is complete, so an
   * export stopped any way at all (even the server or the PC) never leaves a finished-looking but cut-short MP4, and
   * an older video at outFile stays until the new one replaces it.
   */
  partFile: string;
  /** Internal: resolves cleanedUp (the first call counts). */
  settleCleanup: (done: Promise<void>) => void;
}

export const FFMPEG_HELP = [
  'ffmpeg was not found on your PATH, so the MP4 cannot be encoded.',
  'Install it, then restart `npm run dev`:',
  '  Windows:  winget install --id Gyan.FFmpeg   (then open a NEW terminal)',
  '  macOS:    brew install ffmpeg',
  '  Linux:    sudo apt install ffmpeg',
  'Check with:  ffmpeg -version',
].join('\n');

const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg';

export function ffmpegAvailable(): boolean {
  const r = spawnSync(ffmpegBin(), ['-version'], { stdio: 'ignore' });
  return r.status === 0;
}

const versions = new Map<string, string>();

/** `ffmpeg -version` output, asked once per ffmpeg binary. */
function ffmpegVersion(): string {
  const bin = ffmpegBin();
  if (!versions.has(bin)) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    if (r.status !== 0) return '';
    versions.set(bin, String(r.stdout));
  }
  return versions.get(bin)!;
}

/**
 * The option that reads the filter graph from a file, for the ffmpeg that printed `version` (its `-version` output):
 * `-/filter_complex` from ffmpeg 7.0 on (`-filter_complex_script` is deprecated there), `-filter_complex_script` before.
 * Builds from git print no version number; their libavutil version tells (59 came with ffmpeg 7.0). Anything else is
 * taken for a current ffmpeg.
 */
export function graphFileOption(version: string): '-/filter_complex' | '-filter_complex_script' {
  const release = /^ffmpeg version n?(\d+)\.\d/m.exec(version);
  const avutil = /^libavutil\s+(\d+)\./m.exec(version);
  const current = release ? Number(release[1]) >= 7 : avutil ? Number(avutil[1]) >= 59 : true;
  return current ? '-/filter_complex' : '-filter_complex_script';
}

/**
 * Longer filter graphs (many clips or click sounds) go to ffmpeg through a file: Windows allows 32,767 characters for
 * the whole command line, Linux 128 KiB per argument.
 */
const INLINE_GRAPH_MAX = 8000;

const jobs = new Map<string, ExportJob>();
export const getJob = (id: string) => jobs.get(id);

const NO_AUDIO: AudioArgs = { inputs: [], filter: [], codec: [], warnings: [] };

/**
 * Full ffmpeg command: raw RGBA frames at the output size on stdin (input 0), plus the audio inputs and mix from
 * buildAudioArgs. `options` (export options, all optional) set the size, CRF and preset. ffmpeg reports its progress
 * on stdout (-progress), which the watchdog reads.
 */
export function ffmpegArgs(project: Project, outFile: string, audio: AudioArgs = NO_AUDIO, options: ExportOptionsInput = {}): string[] {
  const o = ExportOptionsSchema.parse(options);
  const { outW, outH } = exportSize(project.settings, o.scale);
  return [
    '-y', '-loglevel', 'error', '-progress', 'pipe:1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${outW}x${outH}`, '-r', String(project.settings.fps), '-i', '-',
    ...audio.inputs,
    ...audio.filter,
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p',
    '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...audio.codec,
    // The muxer is named because the file being written is `<name>.mp4.part` (see ExportJob.partFile).
    '-f', 'mp4',
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

/** A plain message for an ffmpeg that could not be started. */
function cannotStart(e: NodeJS.ErrnoException): string {
  if (e.code === 'E2BIG' || e.code === 'ENAMETOOLONG') return `Could not start ffmpeg: its command line is too long (${e.message}). Too many audio clips?`;
  return `Could not start ffmpeg: ${e.message}`;
}

/**
 * Start an export. `baseUrl` is the running server (which serves render.html).
 * Resolves the job object immediately; await job.finished for completion. A job that cannot start (ffmpeg fails to
 * launch) is returned already failed.
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
  /**
   * false: Ctrl+C, a closed terminal window and `kill` are the caller's (the CLI and `npm run dev` cancel the export,
   * which also deletes the unfinished file, then exit); by default Playwright just closes Chromium.
   */
  handleSignals?: boolean;
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
  let settleCleanup!: (done: Promise<void>) => void;
  const cleanedUp = new Promise<void>((res) => (settleCleanup = res));
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
    progressAt: 0,
    finished,
    cleanedUp,
    resolve,
    reject,
    ffmpegClosed: Promise.resolve(),
    partFile: `${opts.outFile}.part`,
    settleCleanup,
  };
  jobs.set(job.id, job);

  // "Include audio" off: no audio inputs at all (and no warnings about missing sound files).
  let audio = options.audio ? buildAudioArgs(opts.project, opts.resolveAsset ?? ((a) => fileInProject(opts.projectDir, a))) : NO_AUDIO;
  job.warnings = audio.warnings;
  let graphFile: string | null = null;
  let ff: ChildProcessWithoutNullStreams;
  try {
    const graph = audio.filter[1] ?? '';
    if (graph.length > INLINE_GRAPH_MAX) {
      graphFile = path.join(os.tmpdir(), `motion-studio-${job.id}.filtergraph`);
      fs.writeFileSync(graphFile, graph);
      audio = { ...audio, filter: [graphFileOption(ffmpegVersion()), graphFile, ...audio.filter.slice(2)] };
    }
    ff = spawn(ffmpegBin(), ffmpegArgs(opts.project, job.partFile, audio, options));
  } catch (e) {
    // E.g. E2BIG: a failed job with a plain message, not a 500 and a job stuck in 'starting'.
    if (graphFile) void removeQuietly(graphFile);
    fail(job, cannotStart(e as NodeJS.ErrnoException));
    return job;
  }
  job.ffmpeg = ff;
  job.ffmpegClosed = new Promise((res) => ff.once('close', () => res()));
  let ffErr = '';
  ff.stderr.on('data', (d) => (ffErr += d.toString()));
  ff.stdin.on('error', () => undefined);
  watchProgress(ff.stdout, () => (job.progressAt = Date.now()));
  // Spawn errors Node reports after spawn() returned (EACCES, EAGAIN, ENOENT, …); 'close' follows.
  ff.on('error', (e) => fail(job, cannotStart(e)));
  ff.on('close', (code) => {
    if (graphFile) void removeQuietly(graphFile);
    clearInterval(job.watchdog);
    if (job.status === 'cancelled') return;
    if (code === 0 && job.status === 'encoding') {
      try {
        renameWithRetry(job.partFile, job.outFile);
      } catch (e) {
        // E.g. an older video of that name is open in a player (Windows locks it). The new one is complete: keep it.
        job.status = 'error';
        job.error = `The video is finished but could not be named ${path.basename(job.outFile)} (is that file open in another program?), so it was left as ${job.partFile}: ${(e as Error).message}`;
        cleanup(job);
        return reject(new Error(job.error));
      }
      job.status = 'done';
      cleanup(job);
      resolve();
    } else if (job.status !== 'done') {
      fail(job, `ffmpeg exited with code ${code}: ${ffErr.trim()}`);
    }
  });
  expectFrame(job);

  (async () => {
    const { chromium } = await import('playwright');
    if (isFinal(job)) return;
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--force-color-profile=srgb', '--disable-gpu'],
      handleSIGINT: opts.handleSignals,
      handleSIGTERM: opts.handleSignals,
      handleSIGHUP: opts.handleSignals,
    });
    job.browser = browser;
    // A cancel or failure can land during any await: from then on only close the browser.
    if (isFinal(job)) return cleanup(job);
    browser.on('disconnected', () => {
      if (job.status === 'starting' || job.status === 'rendering') fail(job, `Headless Chromium closed unexpectedly at frame ${job.frame}/${job.total}, so the export was stopped.`);
    });
    const page = await browser.newPage();
    if (isFinal(job)) return cleanup(job);
    page.on('pageerror', (e) => fail(job, `Render page error: ${e.message}`));
    page.on('crash', () => fail(job, `The render page crashed at frame ${job.frame}/${job.total} (out of memory?), so the export was stopped.`));
    if (job.status === 'starting') job.status = 'rendering';
    await page.goto(`${opts.baseUrl}/render.html?job=${job.id}`);
  })().catch((e: Error) => fail(job, job.browser ? `The render page did not open: ${e.message}` : `Could not start headless Chromium: ${e.message}. Try: npx playwright install --only-shell chromium`));

  return job;
}

/** -progress fields that only change when ffmpeg gets on (fps, speed and bitrate drift while it is stuck). */
const PROGRESS_FIELDS = new Set(['frame', 'out_time_us', 'total_size']);

/** Read ffmpeg's `-progress pipe:1` output (key=value lines, a block every 0.5 s); call `onProgress` when it moves on. */
function watchProgress(stdout: Readable, onProgress: () => void) {
  const last = new Map<string, string>();
  let rest = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop()!;
    for (const line of lines) {
      const eq = line.indexOf('=');
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1).trim();
      if (eq > 0 && PROGRESS_FIELDS.has(key) && last.get(key) !== value) {
        last.set(key, value);
        onProgress();
      }
    }
  });
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
  if (!ff.stdin.write(bytes)) await drained(ff.stdin);
  job.frame = index + 1;
  if (!isFinal(job)) expectFrame(job);
}

/** Resolves on 'drain', or on 'close' when ffmpeg is gone (no 'drain' comes then). */
function drained(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
  });
}

/**
 * How long the next frame may take, headless Chromium's start included (MOTION_RENDER_STALL_TIMEOUT_MS overrides it for
 * tests). Covers a render page that silently stops, which neither a crash nor a disconnect reports.
 */
export const RENDER_STALL_TIMEOUT_MS = 120_000;

/** (Re)start the clock for the next frame: the job fails when none arrives in time. */
function expectFrame(job: ExportJob) {
  const ms = Number(process.env.MOTION_RENDER_STALL_TIMEOUT_MS) || RENDER_STALL_TIMEOUT_MS;
  clearTimeout(job.stall);
  job.stall = setTimeout(() => {
    const s = ms / 1000;
    const stuck = `stuck at frame ${job.frame}/${job.total}`;
    if (job.status === 'starting') fail(job, `Headless Chromium did not start rendering within ${s} s, so the export was stopped.`);
    else if (job.status === 'rendering' && job.ffmpeg?.stdin.writableNeedDrain) fail(job, `ffmpeg took no new frame for ${s} s (${stuck}), so the export was stopped.`);
    else if (job.status === 'rendering') fail(job, `The render page sent no new frame for ${s} s (${stuck}), so the export was stopped.`);
  }, ms);
}

/**
 * How long ffmpeg may go without progress once its input has ended (MOTION_FFMPEG_EXIT_TIMEOUT_MS overrides it for
 * tests). Finishing the video can take minutes (x264's lookahead with a slow preset, 4K), but it keeps making progress.
 */
export const FFMPEG_EXIT_TIMEOUT_MS = 60_000;
/** Extra time per MB of output: moving the index to the front (+faststart) rewrites the whole file and reports nothing. */
const FASTSTART_MS_PER_MB = 100;

export function finishFrames(job: ExportJob) {
  if (isFinal(job)) return;
  if (job.frame !== job.total) return fail(job, `Render page stopped at frame ${job.frame}/${job.total}`);
  job.status = 'encoding';
  clearTimeout(job.stall);
  job.ffmpeg?.stdin.end();
  job.browser?.close().catch(() => undefined);
  watchFlush(job);
}

/**
 * Watchdog while ffmpeg finishes the video. Progress is a -progress report that moved on (ffmpeg 7+ reports while it
 * flushes the encoder) or a bigger output file (ffmpeg 6 reports nothing until it is done). With neither for the limit,
 * ffmpeg is stuck: it is killed (fail → cleanup; a stuck ffmpeg ignores SIGTERM) and the job fails.
 */
function watchFlush(job: ExportJob) {
  const ms = Number(process.env.MOTION_FFMPEG_EXIT_TIMEOUT_MS) || FFMPEG_EXIT_TIMEOUT_MS;
  let size = fileSize(job.partFile);
  job.progressAt = Date.now();
  job.watchdog = setInterval(() => {
    const now = fileSize(job.partFile);
    if (now !== size) {
      size = now;
      job.progressAt = Date.now();
    }
    if (Date.now() - job.progressAt > ms + (size / 1e6) * FASTSTART_MS_PER_MB) {
      fail(job, `ffmpeg made no progress for ${ms / 1000} s while finishing the video, so it was stopped.`);
    }
  }, Math.min(1000, ms / 4));
}

function fileSize(file: string): number {
  return fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
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

/**
 * The signals that stop the CLI or the server: Ctrl+C, Ctrl+Break (Windows), the terminal window closing (SIGHUP, also
 * on Windows) and `kill`. Both cancel their exports first, so no unfinished file stays behind.
 */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;

/**
 * Cancel every export still running; resolves with how many were running once every job has let go of its files and
 * processes (cleanedUp).
 */
export function cancelAll(): Promise<number> {
  const running = [...jobs.values()].filter((j) => !isFinal(j));
  for (const job of running) cancel(job);
  return Promise.all([...jobs.values()].map((j) => j.cleanedUp)).then(() => running.length);
}

function cleanup(job: ExportJob, removeOutput = false) {
  clearInterval(job.watchdog);
  clearTimeout(job.stall);
  const browserClosed = closeBrowser(job.browser);
  if (removeOutput) job.ffmpeg?.kill('SIGKILL');
  // ffmpegClosed was set up when ffmpeg started, so this also works when ffmpeg has already exited by itself.
  const outputGone = job.ffmpegClosed.then(() => (removeOutput ? removeQuietly(job.partFile) : undefined));
  job.settleCleanup(Promise.all([outputGone, browserClosed]).then(() => undefined));
}

/** Close Chromium; resolves when it has closed, or after 5 s if it doesn't answer. */
function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    timer.unref();
    void browser
      .close()
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
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

/** Delete a file, retrying briefly if Windows still has it locked; never fails (it runs in event callbacks). */
function removeQuietly(file: string): Promise<void> {
  return new Promise((resolve) => {
    const attempt = (n: number) => {
      try {
        fs.rmSync(file, { force: true });
        resolve();
      } catch {
        if (n < 5) setTimeout(() => attempt(n + 1), 100);
        else resolve();
      }
    };
    attempt(0);
  });
}
