// When an export goes wrong: ffmpeg slow or stuck after the last frame, headless Chromium crashing or freezing, ffmpeg
// dying, Ctrl+C in the CLI, a very long audio mix, a mistyped project folder. Every failure must end the export with a
// plain message, stop ffmpeg and Chromium, and leave no unfinished MP4 behind; slow but healthy work must not fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { emptyProject, type Project } from '../../src/shared/schema';
import { decodeLeft, makeWav, rms, streams } from './app-audio-helpers';
import { runExport, runRenderCli, startRenderCli, uploadAsset, type Job } from './exportCompare';

const POSIX_ONLY = 'finds and signals ffmpeg and Chromium processes with ps and POSIX signals';

/** Write `project` as <dir>/<name>.motion/project.json, the folder the CLI takes. */
function writeProject(dir: string, project: unknown, name = 'Test'): string {
  const folder = path.join(dir, `${name}.motion`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'project.json'), JSON.stringify(project));
  return folder;
}

/** Nothing but a background: renders fast, and at 2 minutes long enough to interrupt. */
const plain = (seconds: number, width = 320, height = 180): Project =>
  makeProject({ ...emptyProject(), settings: { durationSec: seconds, aspect: 'custom', width, height, fps: 30, background: '#14213d' } });

interface Proc {
  pid: number;
  ppid: number;
  args: string;
}

/** Every process below `pid`, with its command line. */
function descendants(pid: number): Proc[] {
  const all = execFileSync('ps', ['-eww', '-o', 'pid=,ppid=,args='])
    .toString()
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
  const out: Proc[] = [];
  for (let todo = [pid]; todo.length; ) {
    const parent = todo.pop()!;
    for (const p of all) if (p.ppid === parent) out.push(p), todo.push(p.pid);
  }
  return out;
}

/** Still running (a zombie is dead, just not reaped yet)? */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z');
  } catch {
    return false;
  }
}

const isFfmpeg = (p: Proc) => /(^|\/)ffmpeg /.test(p.args);
const isRenderer = (p: Proc) => p.args.includes('--type=renderer');
/** Chromium's main process: Playwright always talks to it through a pipe. */
const isBrowser = (p: Proc) => p.args.includes('--remote-debugging-pipe');

/** The CLI rendering a 2-minute project (320×180 unless `size`), once `ready` holds (by default: past frame 30). */
async function cliRendering(name: string, opts: { env?: NodeJS.ProcessEnv; detached?: boolean; size?: [number, number]; ready?: (out: string, frame: number) => boolean } = {}) {
  const dir = test.info().outputPath(name);
  const folder = writeProject(dir, plain(120, ...(opts.size ?? [320, 180])));
  const out = path.join(dir, 'out.mp4');
  const cli = startRenderCli([folder, out], { ...process.env, MOTION_WORKSPACE: path.join(dir, 'ws'), ...opts.env }, 120_000, { detached: opts.detached });
  const frame = () => Number([...cli.output().matchAll(/rendering (\d+)\//g)].pop()?.[1] ?? 0);
  const ready = opts.ready ?? ((_out: string, f: number) => f > 30);
  await expect.poll(() => ready(out, frame()), { timeout: 60_000, intervals: [5] }).toBe(true);
  const procs = descendants(cli.child.pid!);
  const ffmpeg = procs.find(isFfmpeg);
  expect(ffmpeg, JSON.stringify(procs)).toBeTruthy();
  return { cli, out, procs, ffmpeg: ffmpeg!, frame };
}

/** After a failed CLI export: exit code 1 with `message`, ffmpeg and Chromium gone, no partial MP4. */
async function expectCliFailed(run: Awaited<ReturnType<typeof cliRendering>>, message: string | RegExp, t0: number, withinMs = 20_000) {
  const r = await run.cli.done;
  console.log(`CLI exited ${Date.now() - t0} ms after the event: ${r.stderr.trim().split('\n').pop()}`);
  expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toMatch(message);
  expect(Date.now() - t0).toBeLessThan(withinMs);
  expect(fs.existsSync(run.out), 'no unfinished MP4 left behind').toBe(false);
  await expect.poll(() => running(run.ffmpeg.pid), { timeout: 10_000 }).toBe(false);
  for (const p of run.procs.filter(isBrowser)) await expect.poll(() => running(p.pid), { timeout: 10_000 }).toBe(false);
}

test.describe('ffmpeg after the last frame', () => {
  /** A fake ffmpeg (POSIX shell): answers -version, swallows the frames, then runs `afterInput` ($out = output file). */
  function fakeFfmpeg(dir: string, afterInput: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ffmpeg');
    fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version 6.1.1-fake"; exit 0; fi\nfor a; do out=$a; done\ncat > /dev/null\n${afterInput}\n`, { mode: 0o755 });
    return file;
  }

  test('a slow but working finish is not stopped: progress reports (ffmpeg 7+) or a growing file (ffmpeg 6) keep it going', async () => {
    test.skip(process.platform === 'win32', 'uses POSIX shell scripts as fake ffmpegs');
    const dir = test.info().outputPath('slow');
    const folder = writeProject(dir, plain(0.2, 64, 64));
    const fakes = {
      // 4 s of `-progress pipe:1` blocks, one more frame each time, then the file.
      reports: fakeFfmpeg(path.join(dir, 'reports'), 'for i in 1 2 3 4 5 6 7 8; do printf "frame=%s\\nout_time_us=%s\\ntotal_size=0\\nprogress=continue\\n" $i $((i * 33333)); sleep 0.5; done\nprintf done > "$out"'),
      // ffmpeg 6.1 says nothing while it flushes the encoder, but the file grows.
      writes: fakeFfmpeg(path.join(dir, 'writes'), 'for i in 1 2 3 4 5 6 7 8; do printf 0123456789 >> "$out"; sleep 0.5; done'),
    };
    for (const [kind, fake] of Object.entries(fakes)) {
      const out = path.join(dir, `${kind}.mp4`);
      const r = await runRenderCli([folder, out], { ...process.env, FFMPEG_PATH: fake, MOTION_FFMPEG_EXIT_TIMEOUT_MS: '1500', MOTION_WORKSPACE: path.join(dir, 'ws') }, 60_000);
      expect(r.status, `${kind}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(`Done: ${out}`);
      expect(fs.existsSync(out)).toBe(true);
    }
  });
});

test.describe('headless Chromium failing during the export', () => {
  test.skip(process.platform === 'win32', POSIX_ONLY);

  test('CLI: a crashed render page fails the export at once; ffmpeg and Chromium stop, no partial MP4', async () => {
    const run = await cliRendering('crash');
    const renderers = run.procs.filter(isRenderer);
    expect(renderers.length, JSON.stringify(run.procs)).toBeGreaterThan(0);
    const t0 = Date.now();
    for (const p of renderers) process.kill(p.pid, 'SIGKILL');
    await expectCliFailed(run, /Export failed: The render page crashed at frame \d+\/3600 \(out of memory\?\), so the export was stopped\./, t0);
  });

  test('CLI: Chromium itself dying fails the export', async () => {
    const run = await cliRendering('browser-gone');
    const browser = run.procs.find(isBrowser);
    expect(browser, JSON.stringify(run.procs)).toBeTruthy();
    const t0 = Date.now();
    process.kill(browser!.pid, 'SIGKILL');
    await expectCliFailed(run, /Export failed: (Headless Chromium closed unexpectedly|The render page crashed) at frame \d+\/3600/, t0);
  });

  test('CLI: a render page that freezes fails the export after MOTION_RENDER_STALL_TIMEOUT_MS', async () => {
    const run = await cliRendering('frozen', { env: { MOTION_RENDER_STALL_TIMEOUT_MS: '3000' } });
    const renderers = run.procs.filter(isRenderer);
    expect(renderers.length, JSON.stringify(run.procs)).toBeGreaterThan(0);
    const t0 = Date.now();
    try {
      for (const p of renderers) process.kill(p.pid, 'SIGSTOP');
      await expectCliFailed(run, /Export failed: The render page sent no new frame for 3 s \(stuck at frame \d+\/3600\), so the export was stopped\./, t0);
    } finally {
      for (const p of renderers) if (running(p.pid)) process.kill(p.pid, 'SIGKILL');
    }
  });
});

test.describe('a failed or cancelled export leaves no unfinished MP4', () => {
  test.skip(process.platform === 'win32', POSIX_ONLY);

  test('CLI: Ctrl+C cancels, stops ffmpeg and Chromium and deletes the unfinished file', async () => {
    // Pressed the moment ffmpeg creates the file: the CLI used to exit (or Playwright's own Ctrl+C handler exited it
    // with 130) before ffmpeg was gone, and the empty MP4 stayed, in about half of the runs.
    for (let i = 0; i < 3; i++) {
      const run = await cliRendering(`ctrl-c-${i}`, { detached: true, size: [1280, 720], ready: (out) => fs.existsSync(out) });
      const t0 = Date.now();
      // Ctrl+C in a terminal: SIGINT to the CLI's whole process group (node and ffmpeg; Chromium has its own group).
      process.kill(-run.cli.child.pid!, 'SIGINT');
      await expectCliFailed(run, 'Export failed: Export cancelled', t0);
      expect((await run.cli.done).stdout).toContain('Cancelling…');
    }
  });

  test('server: ffmpeg dying mid-export fails the job and deletes the unfinished file', async ({ request }) => {
    const start = await request.post('/api/export', { data: { project: plain(120) } });
    expect(start.ok(), await start.text()).toBe(true);
    let job = (await start.json()) as Job;
    await expect.poll(async () => (job = await (await request.get(`/api/jobs/${job.id}`)).json()).frame, { timeout: 60_000 }).toBeGreaterThan(30);
    expect(fs.existsSync(job.outFile)).toBe(true);
    const ffmpeg = execFileSync('ps', ['-eww', '-o', 'pid=,args='])
      .toString()
      .split('\n')
      .find((l) => /ffmpeg /.test(l) && l.includes(job.outFile));
    expect(ffmpeg).toBeTruthy();
    process.kill(Number(/^\s*(\d+)/.exec(ffmpeg!)![1]), 'SIGKILL');
    await expect.poll(async () => (job = await (await request.get(`/api/jobs/${job.id}`)).json()).status, { timeout: 10_000 }).toBe('error');
    expect(job.error).toMatch(/^ffmpeg exited with code null/);
    await expect.poll(() => fs.existsSync(job.outFile), { timeout: 5_000 }).toBe(false);
  });
});

test('1200 click sounds: the export works (one input, the mix in a file) and every click is heard in time', async ({ request }) => {
  // 1200 clicks every 20 ms over 24 s: the old command (one input and one filter chain per click) was 290 KB long,
  // over Linux's 128 KiB per argument (and Windows' 32,767 characters for the whole command line from ~120 clicks).
  const n = 1200;
  const seconds = 24;
  const tick = makeWav(test.info().outputPath('tick.wav'), { expr: '0.8*sin(2*PI*2000*t)', seconds: 0.005, rate: 48000, channels: 2 });
  const { hash } = await uploadAsset(request, tick);
  const project = makeProject({
    ...emptyProject(),
    settings: { durationSec: seconds, aspect: 'custom', width: 160, height: 90, fps: 10, background: '#14213d' },
    assets: [{ id: 'tick', originalName: 'tick.wav', relativePath: `assets/${hash.slice(0, 8)}-tick.wav`, type: 'audio', hash, duration: 0.005 }],
    scenes: [
      {
        id: 's1', name: 'Scene 1', start: 0, duration: seconds,
        layers: [
          makeLayer({
            id: 'cur', name: 'Cursor', type: 'cursor', visible: true, locked: false, start: 0, duration: seconds, anchorX: 0, anchorY: 0, x: 0, y: 0,
            scale: 1, rotation: 0, opacity: 1, keyframes: {}, points: [{ id: 'p0', x: 20, y: 20, time: 0 }, { id: 'p1', x: 140, y: 70, time: seconds }],
            smoothing: 0.5, size: 12, color: '#ffffff', rippleColor: '#ffffff66',
            clicks: Array.from({ length: n }, (_, i) => ({ id: `k${i}`, time: Math.round((i + 0.5) * 20) / 1000 })),
            clickSound: { assetId: 'tick', volume: 1 },
          }),
        ],
      },
    ],
  });
  const job = await runExport(request, { project }, 120_000);
  const [video, audio] = ['video', 'audio'].map((t) => streams(job.outFile).find((s) => s.codec_type === t)!);
  expect(Number(audio.start_time)).toBe(0);
  expect(Number(audio.duration)).toBeCloseTo(Number(video.duration), 3);
  expect(Number(video.duration)).toBeCloseTo(seconds, 3);
  // Click k (5 ms) starts at 20k + 10 ms: the 10 ms it falls in are loud, the 10 ms before are quiet.
  const s = decodeLeft(job.outFile);
  const click = Array.from({ length: n }, (_, k) => rms(s, k * 0.02 + 0.01, k * 0.02 + 0.02));
  const before = Array.from({ length: n }, (_, k) => rms(s, k * 0.02, k * 0.02 + 0.01));
  console.log(`click windows: min RMS ${Math.min(...click).toFixed(3)}; windows before: max RMS ${Math.max(...before).toFixed(3)}`);
  expect(Math.min(...click)).toBeGreaterThan(0.2);
  expect(Math.max(...before)).toBeLessThan(0.1);
});

test('CLI: a mistyped or broken project folder gives one plain line and the exit code 2, no stack trace', async () => {
  const dir = test.info().outputPath('bad-folders');
  const out = path.join(dir, 'out.mp4');
  const cases = [
    { folder: path.join(dir, 'Typo.motion'), line: `Cannot open the project: ${path.join(dir, 'Typo.motion')} does not exist`, usage: true },
    { folder: (fs.mkdirSync(path.join(dir, 'Empty.motion'), { recursive: true }), path.join(dir, 'Empty.motion')), line: `Cannot open the project: No project.json in ${path.join(dir, 'Empty.motion')}`, usage: true },
    { folder: writeProject(dir, { schemaVersion: 2, settings: { durationSec: -1 } }, 'Invalid'), line: 'Cannot open the project: Invalid project: settings.durationSec: ', usage: false },
    { folder: (fs.mkdirSync(path.join(dir, 'Garbled.motion'), { recursive: true }), fs.writeFileSync(path.join(dir, 'Garbled.motion', 'project.json'), '{ "schemaVersion": 2,'), path.join(dir, 'Garbled.motion')), line: 'Cannot open the project: project.json is not valid JSON', usage: false },
  ];
  for (const c of cases) {
    const r = await runRenderCli([c.folder, out], { ...process.env, MOTION_WORKSPACE: path.join(dir, 'ws') }, 60_000);
    const lines = r.stderr.trim().split(/\r?\n/);
    expect(r.status, r.stderr).toBe(2);
    expect(lines[0]).toContain(c.line);
    expect(r.stderr).not.toMatch(/HttpError|\n\s+at |Node\.js v/);
    // A wrong folder also gets the usage (after an empty line); a broken project.json only its one line.
    if (c.usage) expect(lines.slice(1, 3)).toEqual(['', 'Usage: npm run render -- <projectFolder.motion> <out.mp4> [options]']);
    else expect(lines).toHaveLength(1);
  }
});
