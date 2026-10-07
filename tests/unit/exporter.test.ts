// Export jobs with a fake ffmpeg process and a fake headless Chromium: every way an export can go wrong must end the job
// (never stuck in starting/rendering/encoding), stop ffmpeg and Chromium, and remove the partial MP4.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptFrame, cancel, cancelAll, finishFrames, graphFileOption, startExport, type ExportJob as Job } from '../../server/exporter';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { emptyProject, type Project } from '../../src/shared/schema';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), launch: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock('playwright', () => ({ chromium: { launch: mocks.launch } }));

/** A child process that behaves like ffmpeg as far as the exporter can tell. */
class FakeFfmpeg extends EventEmitter {
  readonly stdin = new Writable({ highWaterMark: 1 << 30, write: (_chunk, _enc, done) => done() });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];
  /** False: a kill is only recorded (the process takes its time to die; call exit()). */
  diesOnKill = true;

  constructor(readonly args: string[]) {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal);
    if (this.diesOnKill && signal === 'SIGKILL') this.exit(null, 'SIGKILL');
    return true;
  }

  /** The file it writes (its last argument). */
  get output() {
    return this.args[this.args.length - 1];
  }

  /**
   * Ends like a real process: exit code and signal first, the 'exit' and 'close' events a moment later. Like a real
   * ffmpeg, one that succeeds has written its output file.
   */
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    if (code === 0 && !fs.existsSync(this.output)) fs.writeFileSync(this.output, 'the video');
    this.exitCode = code;
    this.signalCode = signal;
    setImmediate(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }

  /** A spawn failure Node reports after spawn() returned (EACCES, ENOENT, …): exit code, 'error', then 'close'. */
  failToSpawn(code: string, errno: number) {
    this.exitCode = errno;
    this.emit('error', Object.assign(new Error(`spawn ffmpeg ${code}`), { code, errno, syscall: 'spawn ffmpeg' }));
    setImmediate(() => this.emit('close', errno, null));
  }

  /** One `-progress pipe:1` block on stdout. */
  progress(frame: number) {
    this.stdout.write(`frame=${frame}\nfps=1.0\nout_time_us=${frame * 33333}\ntotal_size=${frame * 1000}\nprogress=continue\n`);
  }
}

class FakePage extends EventEmitter {
  readonly goto = vi.fn(async (_url: string) => null);
}

class FakeBrowser extends EventEmitter {
  readonly page = new FakePage();
  readonly newPage = vi.fn(async () => this.page);
  closed = false;
  readonly close = vi.fn(async () => {
    if (this.closed) return;
    this.closed = true;
    this.emit('disconnected', this);
  });
}

const tiny = makeProject({ ...emptyProject(), settings: { durationSec: 0.3, aspect: 'custom', width: 64, height: 64, fps: 10, background: '#000000' } });
const FRAME = Buffer.alloc(64 * 64 * 4);
const VERSION_6 = 'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers\nlibavutil      58. 29.100 / 58. 29.100\n';
const VERSION_8 = 'ffmpeg version n8.1.3-14-g330caae0c1-20261006 Copyright (c) 2000-2026 the FFmpeg developers\nlibavutil      60. 26.103 / 60. 26.103\n';

let ff: FakeFfmpeg;
let browser: FakeBrowser;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-exporter-test-'));
  mocks.spawnSync.mockReset().mockReturnValue({ status: 0, stdout: VERSION_6, stderr: '' });
  mocks.spawn.mockReset().mockImplementation((_bin: string, args: string[]) => (ff = new FakeFfmpeg(args)));
  browser = new FakeBrowser();
  mocks.launch.mockReset().mockImplementation(async () => browser);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const start = (project: Project = tiny, resolveAsset?: (a: { id: string }) => string | null) =>
  startExport({ project, projectDir: null, outFile: path.join(dir, 'out.mp4'), baseUrl: 'http://127.0.0.1:1', resolveAsset });

/** Let pending callbacks and I/O run until `done()` holds (setImmediate and performance are never faked here). */
async function until(done: () => boolean) {
  const t0 = performance.now();
  while (!done() && performance.now() - t0 < 5000) await new Promise((r) => setImmediate(r));
  expect(done()).toBe(true);
}

/** Wait until the fake render page is loading: the job is 'rendering'. */
async function rendering(job: Job) {
  await until(() => browser.page.goto.mock.calls.length > 0);
  expect(job.status).toBe('rendering');
}

async function allFrames(job: Job) {
  for (let i = 0; i < job.total; i++) await acceptFrame(job, i, FRAME);
}

/** Timers the exporter uses are faked; setImmediate (fake process events) stays real. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

describe('after the last frame, while ffmpeg finishes the video', () => {
  it('ffmpeg is not stopped while it reports progress, however long it takes', async () => {
    vi.stubEnv('MOTION_FFMPEG_EXIT_TIMEOUT_MS', '1000');
    const job = await start();
    await rendering(job);
    fakeTimers();
    await allFrames(job);
    finishFrames(job);
    expect(ff.args.slice(0, 5)).toEqual(['-y', '-loglevel', 'error', '-progress', 'pipe:1']);
    // A slow flush (x264 lookahead, a slow preset, 4K): 10 s, ten times the limit, one more frame every 0.5 s.
    for (let frame = 1; frame <= 20; frame++) {
      ff.progress(frame);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(job.status).toBe('encoding');
    expect(ff.signals).toEqual([]);
    ff.exit(0);
    await job.finished;
    expect(job.status).toBe('done');
  });

  it('a growing output file counts as progress (ffmpeg 6 reports nothing while it flushes)', async () => {
    vi.stubEnv('MOTION_FFMPEG_EXIT_TIMEOUT_MS', '1000');
    const job = await start();
    await rendering(job);
    fakeTimers();
    await allFrames(job);
    finishFrames(job);
    for (let i = 0; i < 20; i++) {
      fs.appendFileSync(job.partFile, Buffer.alloc(4096));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(job.status).toBe('encoding');
    ff.exit(0);
    await job.finished;
    expect(job.status).toBe('done');
  });

  it('ffmpeg is stopped (SIGKILL) and the export fails when nothing advances for the limit', async () => {
    vi.stubEnv('MOTION_FFMPEG_EXIT_TIMEOUT_MS', '1000');
    const job = await start();
    await rendering(job);
    fakeTimers();
    await allFrames(job);
    finishFrames(job);
    // The same block again is not progress.
    ff.progress(3);
    await vi.advanceTimersByTimeAsync(500);
    ff.progress(3);
    await vi.advanceTimersByTimeAsync(400);
    expect(job.status).toBe('encoding');
    await vi.advanceTimersByTimeAsync(1000);
    expect(job.status).toBe('error');
    expect(job.error).toBe('ffmpeg made no progress for 1 s while finishing the video, so it was stopped.');
    expect(ff.signals).toEqual(['SIGKILL']);
  });
});

describe('while starting and rendering', () => {
  it('a crashed render page fails the job and stops ffmpeg and Chromium', async () => {
    const job = await start();
    await rendering(job);
    await acceptFrame(job, 0, FRAME);
    browser.page.emit('crash', browser.page);
    expect(job.status).toBe('error');
    expect(job.error).toBe('The render page crashed at frame 1/3 (out of memory?), so the export was stopped.');
    await expect(job.finished).rejects.toThrow('The render page crashed');
    await job.cleanedUp;
    expect(ff.signals).toEqual(['SIGKILL']);
    expect(browser.close).toHaveBeenCalled();
  });

  it('headless Chromium closing unexpectedly fails the job', async () => {
    const job = await start();
    await rendering(job);
    await acceptFrame(job, 0, FRAME);
    browser.emit('disconnected', browser);
    expect(job.status).toBe('error');
    expect(job.error).toBe('Headless Chromium closed unexpectedly at frame 1/3, so the export was stopped.');
    await job.cleanedUp;
    expect(ff.signals).toEqual(['SIGKILL']);
  });

  it('Chromium closing after the last frame (the exporter closes it) is not a failure', async () => {
    const job = await start();
    await rendering(job);
    await allFrames(job);
    finishFrames(job);
    expect(browser.close).toHaveBeenCalled();
    expect(browser.closed).toBe(true);
    expect(job.status).toBe('encoding');
    ff.exit(0);
    await job.finished;
    expect(job.status).toBe('done');
  });

  it('a render page that stops sending frames fails the job after MOTION_RENDER_STALL_TIMEOUT_MS', async () => {
    vi.stubEnv('MOTION_RENDER_STALL_TIMEOUT_MS', '2000');
    fakeTimers();
    const job = await start();
    await rendering(job);
    await acceptFrame(job, 0, FRAME);
    await vi.advanceTimersByTimeAsync(1500);
    // Every frame restarts the clock.
    await acceptFrame(job, 1, FRAME);
    await vi.advanceTimersByTimeAsync(1500);
    expect(job.status).toBe('rendering');
    await vi.advanceTimersByTimeAsync(600);
    expect(job.status).toBe('error');
    expect(job.error).toBe('The render page sent no new frame for 2 s (stuck at frame 2/3), so the export was stopped.');
    await job.cleanedUp;
    expect(ff.signals).toEqual(['SIGKILL']);
    expect(browser.close).toHaveBeenCalled();
  });

  it('the same limit applies while headless Chromium starts', async () => {
    vi.stubEnv('MOTION_RENDER_STALL_TIMEOUT_MS', '2000');
    fakeTimers();
    let launched!: (b: FakeBrowser) => void;
    mocks.launch.mockImplementation(() => new Promise((r) => (launched = r)));
    const job = await start();
    await until(() => mocks.launch.mock.calls.length > 0);
    await vi.advanceTimersByTimeAsync(2100);
    expect(job.status).toBe('error');
    expect(job.error).toBe('Headless Chromium did not start rendering within 2 s, so the export was stopped.');
    // When the launch completes after all, that browser is closed straight away.
    launched(browser);
    await until(() => browser.closed);
    expect(browser.newPage).not.toHaveBeenCalled();
  });
});

describe('the partial MP4 of a failed or cancelled export', () => {
  it('is written as <name>.mp4.part: the real name only ever holds a complete video', async () => {
    const job = await start();
    await rendering(job);
    expect(job.partFile).toBe(path.join(dir, 'out.mp4.part'));
    expect(ff.output).toBe(job.partFile);
    expect(ff.args.slice(-5)).toEqual(['-f', 'mp4', '-movflags', '+faststart', job.partFile]);
    fs.writeFileSync(job.partFile, 'half a video');
    await allFrames(job);
    finishFrames(job);
    expect(fs.existsSync(job.outFile)).toBe(false);
    ff.exit(0);
    await job.finished;
    expect(fs.readFileSync(job.outFile, 'utf8')).toBe('half a video');
    expect(fs.existsSync(job.partFile)).toBe(false);
  });

  it('is removed when ffmpeg fails by itself (e.g. disk full)', async () => {
    const job = await start();
    await rendering(job);
    fs.writeFileSync(job.partFile, 'partial');
    ff.stderr.write('[vost#0:0/libx264] Error submitting a packet to the muxer: No space left on device\n');
    ff.exit(228);
    await expect(job.finished).rejects.toThrow('ffmpeg exited with code 228: [vost#0:0/libx264] Error submitting a packet to the muxer: No space left on device');
    await job.cleanedUp;
    expect(fs.existsSync(job.partFile)).toBe(false);
    expect(fs.existsSync(job.outFile)).toBe(false);
  });

  it('an older video at the output path (the CLI can render over one) stays when the new export fails', async () => {
    fs.writeFileSync(path.join(dir, 'out.mp4'), 'last week\'s video');
    const job = await start();
    await rendering(job);
    fs.writeFileSync(job.partFile, 'partial');
    ff.exit(1);
    await expect(job.finished).rejects.toThrow('ffmpeg exited with code 1');
    await job.cleanedUp;
    expect(fs.readFileSync(job.outFile, 'utf8')).toBe('last week\'s video');
    expect(fs.existsSync(job.partFile)).toBe(false);
  });

  it('a finished video that cannot take its name is kept as .part, with a plain message', async () => {
    const job = await start();
    await rendering(job);
    await allFrames(job);
    finishFrames(job);
    // Something in the way that Windows' retries can't wait out (here: a folder of that name).
    fs.mkdirSync(path.join(job.outFile, 'x'), { recursive: true });
    ff.exit(0);
    await expect(job.finished).rejects.toThrow(`The video is finished but could not be named out.mp4 (is that file open in another program?), so it was left as ${job.partFile}: `);
    await job.cleanedUp;
    expect(job.status).toBe('error');
    expect(fs.readFileSync(job.partFile, 'utf8')).toBe('the video');
  });

  it('is removed after a cancel once ffmpeg has exited, and cleanedUp waits for that', async () => {
    const job = await start();
    await rendering(job);
    ff.diesOnKill = false;
    fs.writeFileSync(job.partFile, 'partial');
    cancel(job);
    expect(ff.signals).toEqual(['SIGKILL']);
    let cleaned = false;
    void job.cleanedUp.then(() => (cleaned = true));
    await until(() => browser.closed);
    expect(cleaned).toBe(false);
    ff.exit(null, 'SIGKILL');
    await job.cleanedUp;
    expect(fs.existsSync(job.partFile)).toBe(false);
    expect(fs.existsSync(job.outFile)).toBe(false);
    expect(job.status).toBe('cancelled');
  });

  it('a finished export keeps its file', async () => {
    const job = await start();
    await rendering(job);
    await allFrames(job);
    finishFrames(job);
    fs.writeFileSync(job.partFile, 'the video');
    ff.exit(0);
    await job.finished;
    await job.cleanedUp;
    expect(fs.readFileSync(job.outFile, 'utf8')).toBe('the video');
  });
});

describe('cancelAll (the server or the CLI is being stopped)', () => {
  it('cancels every running export and resolves once their unfinished files are gone', async () => {
    const a = await start();
    const first = ff;
    await rendering(a);
    browser = new FakeBrowser();
    const b = await startExport({ project: tiny, projectDir: null, outFile: path.join(dir, 'b.mp4'), baseUrl: 'http://127.0.0.1:1' });
    await until(() => browser.page.goto.mock.calls.length > 0);
    for (const [job, f] of [[a, first], [b, ff]] as const) {
      fs.writeFileSync(job.partFile, 'partial');
      f.diesOnKill = false;
    }
    let count: number | undefined;
    void cancelAll().then((n) => (count = n));
    expect([a.status, b.status]).toEqual(['cancelled', 'cancelled']);
    await until(() => first.signals.length > 0 && ff.signals.length > 0);
    expect(count).toBeUndefined();
    first.exit(null, 'SIGKILL');
    ff.exit(null, 'SIGKILL');
    await until(() => count !== undefined);
    expect(count).toBe(2);
    expect([a.partFile, b.partFile].filter((f) => fs.existsSync(f))).toEqual([]);
    // Nothing left to stop: resolves with 0.
    expect(await cancelAll()).toBe(0);
  });
});

describe('cancel', () => {
  it('a cancel that lands while Chromium opens its page stays cancelled (not "ffmpeg exited with code null")', async () => {
    let opened!: (p: FakePage) => void;
    browser.newPage.mockImplementation(() => new Promise((r) => (opened = r)));
    const job = await start();
    await until(() => browser.newPage.mock.calls.length > 0);
    expect(job.status).toBe('starting');
    cancel(job);
    opened(browser.page);
    await job.cleanedUp;
    await until(() => browser.closed);
    expect(job.status).toBe('cancelled');
    expect(job.error).toBeUndefined();
    expect(browser.page.goto).not.toHaveBeenCalled();
  });

  it('a cancel while Chromium launches closes it as soon as it is up', async () => {
    let launched!: (b: FakeBrowser) => void;
    mocks.launch.mockImplementation(() => new Promise((r) => (launched = r)));
    const job = await start();
    await until(() => mocks.launch.mock.calls.length > 0);
    cancel(job);
    await job.cleanedUp;
    launched(browser);
    await until(() => browser.closed);
    expect(browser.newPage).not.toHaveBeenCalled();
    expect(job.status).toBe('cancelled');
  });
});

describe('starting ffmpeg', () => {
  it('a spawn that throws (E2BIG) fails the job with a plain message instead of leaving it "starting"', async () => {
    mocks.spawn.mockImplementation(() => {
      throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG', errno: -7, syscall: 'spawn' });
    });
    const job = await start();
    expect(job.status).toBe('error');
    expect(job.error).toBe('Could not start ffmpeg: its command line is too long (spawn E2BIG). Too many audio clips?');
    await expect(job.finished).rejects.toThrow('Could not start ffmpeg');
    await job.cleanedUp;
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('a spawn error reported afterwards (an "error" event) fails the job too', async () => {
    const job = await start();
    ff.failToSpawn('EACCES', -13);
    expect(job.status).toBe('error');
    expect(job.error).toBe('Could not start ffmpeg: spawn ffmpeg EACCES');
    await job.cleanedUp;
  });
});

/** A 120 s project whose cursor clicks `n` times with a click sound. */
function clicksProject(n: number): Project {
  const p = makeProject({ ...emptyProject(), settings: { durationSec: 120, aspect: '16:9', width: 1920, height: 1080, fps: 30, background: '#000000' } });
  p.assets.push({ id: 'tick', originalName: 'tick.wav', relativePath: `assets/${'a'.repeat(8)}-tick.wav`, type: 'audio', hash: 'a'.repeat(64), duration: 0.03 });
  const cursor = makeLayer({
    id: 'cur', name: 'Cursor', type: 'cursor', visible: true, locked: false, start: 0, duration: 120, anchorX: 0, anchorY: 0, x: 0, y: 0,
    scale: 1, rotation: 0, opacity: 1, keyframes: {}, points: [], smoothing: 0, size: 40, color: '#fff', rippleColor: '#fff6',
    clicks: Array.from({ length: n }, (_, i) => ({ id: `k${i}`, time: (i + 0.5) * (120 / n) })), clickSound: { assetId: 'tick', volume: 1 },
  });
  p.scenes = [{ id: 's', name: 'S', start: 0, duration: 120, layers: [cursor], background: null, transition: { type: 'none', duration: 0.6, direction: 'left', easing: { type: 'easeInOut' } } }];
  return p;
}

/** How Windows sees a command line (CreateProcess quoting). */
const windowsCommandLine = (args: string[]) => ['ffmpeg', ...args].map((a) => (/[\s"]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
const SCRATCH_WAV = `C:\\Users\\Bryan\\motion-studio\\workspace\\.scratch\\${'a'.repeat(64)}.wav`;

describe('a long audio mix (many clips or click sounds)', () => {
  it('1200 click sounds: four inputs, the graph in a file; the command fits Windows (32,767 chars) and Linux (128 KiB per argument)', async () => {
    const job = await start(clicksProject(1200), () => SCRATCH_WAV);
    expect(job.status).toBe('starting');
    // stdin + 4 × the click sound (333 clicks of 0.03 s each, see SHARED_INPUT_SECONDS).
    expect(ff.args.filter((a) => a === '-i')).toHaveLength(5);
    expect(ff.args).not.toContain('-filter_complex');
    const at = ff.args.indexOf('-filter_complex_script');
    expect(at).toBeGreaterThan(0);
    const graphFile = ff.args[at + 1];
    expect(fs.readFileSync(graphFile, 'utf8')).toMatch(/^\[1:a\]asplit=333\[a0\]\[a1\]/);
    expect(windowsCommandLine(ff.args).length).toBeLessThan(32767);
    expect(Math.max(...ff.args.map((a) => Buffer.byteLength(a)))).toBeLessThan(128 * 1024);
    // The file goes away with the job.
    cancel(job);
    await job.cleanedUp;
    expect(fs.existsSync(graphFile)).toBe(false);
  });

  it('ffmpeg 7 and newer get the file with -/filter_complex (-filter_complex_script is deprecated there)', async () => {
    vi.stubEnv('FFMPEG_PATH', '/opt/ffmpeg-8.1/bin/ffmpeg');
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: VERSION_8, stderr: '' });
    const job = await start(clicksProject(200), () => SCRATCH_WAV);
    const at = ff.args.indexOf('-/filter_complex');
    expect(at).toBeGreaterThan(0);
    expect(ff.args).not.toContain('-filter_complex_script');
    expect(fs.readFileSync(ff.args[at + 1], 'utf8')).toMatch(/^\[1:a\]asplit=200\[a0\]/);
    ff.exit(1);
    await job.cleanedUp;
    expect(fs.existsSync(ff.args[at + 1])).toBe(false);
  });

  it('a short graph stays on the command line', async () => {
    const job = await start(clicksProject(3), () => SCRATCH_WAV);
    expect(ff.args[ff.args.indexOf('-filter_complex') + 1]).toMatch(/^\[1:a\]asplit=3\[a0\]\[a1\]\[a2\];/);
    cancel(job);
    await job.cleanedUp;
  });

  it('the option is picked from `ffmpeg -version` (-/opt files exist since ffmpeg 7.0)', () => {
    const cases: [string, string][] = [
      [VERSION_6, '-filter_complex_script'], // Ubuntu 24.04 (CI on Linux)
      ['ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024 the FFmpeg developers', '-filter_complex_script'], // Debian 12
      ['ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers', '-filter_complex_script'],
      ['ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/  Copyright (c) 2000-2024 the FFmpeg developers', '-/filter_complex'],
      ['ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers', '-/filter_complex'],
      [VERSION_8, '-/filter_complex'], // BtbN release build (CI on Windows)
      ['ffmpeg version 8.0-essentials_build-www.gyan.dev Copyright (c) 2000-2025 the FFmpeg developers', '-/filter_complex'], // winget, Chocolatey
      // Builds from git have no version number: their libavutil major version tells (59 = ffmpeg 7).
      ['ffmpeg version N-121234-g0123abcd56-20251005 Copyright (c) 2000-2025 the FFmpeg developers\nlibavutil      60. 13.100 / 60. 13.100', '-/filter_complex'],
      ['ffmpeg version 2023-11-02-git-0123abcd-full_build-www.gyan.dev Copyright (c) 2000-2023 the FFmpeg developers\nlibavutil      58. 29.100 / 58. 29.100', '-filter_complex_script'],
      ['something else entirely', '-/filter_complex'],
    ];
    for (const [version, option] of cases) expect([version.split('\n')[0], graphFileOption(version)]).toEqual([version.split('\n')[0], option]);
  });
});
