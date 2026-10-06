// Shared helpers for export tests: upload/save/export through the real API, then compare MP4 frames
// against renderFrame output (rendered by render.html in the same browser) pixel by pixel.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Project } from '../../src/shared/schema';

export const WS = path.resolve('.e2e-workspace');

export async function uploadAsset(request: APIRequestContext, file: string): Promise<{ hash: string }> {
  const r = await request.post('/api/assets', {
    data: fs.readFileSync(file),
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(path.basename(file)) },
  });
  expect(r.ok()).toBe(true);
  return r.json();
}

export async function saveProject(request: APIRequestContext, name: string, project: unknown) {
  const r = await request.put(`/api/projects/${encodeURIComponent(name)}`, { data: project });
  expect(r.ok(), await r.text()).toBe(true);
  return path.join(WS, `${name}.motion`);
}

export interface Job {
  id: string;
  status: string;
  frame: number;
  total: number;
  error?: string;
  outFile: string;
  [k: string]: unknown;
}

/**
 * Start an export through the same endpoint the Export button uses and wait until it is done. `body` is
 * { project, name?, scale?, crf?, preset?, audio? } (export options are optional). A failed job reports its error.
 */
export async function runExport(request: APIRequestContext, body: Record<string, unknown>, timeout = 150_000): Promise<Job> {
  const start = await request.post('/api/export', { data: body });
  expect(start.ok(), await start.text()).toBe(true);
  let job = (await start.json()) as Job;
  await expect
    .poll(async () => {
      job = await (await request.get(`/api/jobs/${job.id}`)).json();
      return job.status === 'error' ? `error: ${job.error}` : job.status;
    }, { timeout, intervals: [250] })
    .toBe('done');
  return job;
}

export function rgbFromVideo(file: string, frame: number): Buffer {
  return execFileSync('ffmpeg', [
    '-loglevel', 'error', '-i', file,
    '-vf', `select=eq(n\\,${frame}),scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 256 * 1024 * 1024 });
}

export function rgbFromPng(file: string): Buffer {
  return execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 * 1024 * 1024 });
}

export function pixelDiff(a: Buffer, b: Buffer) {
  expect(a.length).toBe(b.length);
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += Math.abs(d);
    sq += d * d;
  }
  const mse = sq / a.length;
  return { meanAbs: sum / a.length, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse) };
}

export function probe(file: string, stream = 'v:0') {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', stream, '-count_frames',
    '-show_entries', 'stream=codec_name,codec_type,width,height,pix_fmt,nb_read_frames,r_frame_rate,sample_rate,channels,duration',
    '-of', 'json', file,
  ]).toString();
  return JSON.parse(out).streams[0];
}

/**
 * Render `project` at time t in render.html (same browser) and return it as a PNG file path. `exportScale` renders
 * exactly like an export at that size (even output size + fill scale, src/shared/exportSize.ts); `scale` is a plain
 * render scale.
 */
export async function renderPng(page: Page, project: unknown, t: number, projectName: string | null, outName: string, scale = 1, exportScale?: number): Promise<string> {
  if (!page.url().includes('/render.html')) {
    await page.goto('/render.html');
    await expect(page).toHaveTitle('render-ready');
  }
  const { png } = await page.evaluate(
    ({ p, t, projectName, scale, exportScale }) => (window as any).motion.render(p, t, { projectName: projectName ?? undefined, scale, exportScale }),
    { p: project, t, projectName, scale, exportScale },
  );
  const file = test.info().outputPath(outName);
  fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
  return file;
}

/**
 * For each frame index: renderFrame(t = frame/fps) vs the decoded MP4 frame. Asserts mean |diff| < maxMeanAbs and
 * PSNR > minPsnr, and that a clearly different frame (`wrongFrame`) differs much more (proves timing is right).
 */
export async function expectExportMatchesRender(
  page: Page,
  opts: { project: Project; projectName: string | null; mp4: string; frames: number[]; wrongFrame?: (f: number) => number; maxMeanAbs?: number; minPsnr?: number; scale?: number; exportScale?: number },
) {
  const fps = opts.project.settings.fps;
  const results: { frame: number; meanAbs: number; psnr: number }[] = [];
  for (const frame of opts.frames) {
    const pngFile = await renderPng(page, opts.project, frame / fps, opts.projectName, `render-${frame}.png`, opts.scale ?? 1, opts.exportScale);
    const expected = rgbFromPng(pngFile);
    const actual = rgbFromVideo(opts.mp4, frame);
    const d = pixelDiff(expected, actual);
    console.log(`frame ${frame} (t=${(frame / fps).toFixed(3)}s): mean abs diff ${d.meanAbs.toFixed(3)}, PSNR ${d.psnr.toFixed(2)} dB`);
    expect(d.meanAbs).toBeLessThan(opts.maxMeanAbs ?? 1.5);
    expect(d.psnr).toBeGreaterThan(opts.minPsnr ?? 36);
    if (opts.wrongFrame) {
      const wrong = pixelDiff(expected, rgbFromVideo(opts.mp4, opts.wrongFrame(frame)));
      expect(wrong.meanAbs).toBeGreaterThan(d.meanAbs * 2);
    }
    results.push({ frame, ...d });
  }
  return results;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI renderer through node + tsx's CLI file (no bare `npx`, so it also works on Windows). Async with a
 * timeout shorter than the Playwright test timeout, so a hung render is reported instead of blocking the worker.
 */
export function runRenderCli(args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 150_000): Promise<CliResult> {
  return startRenderCli(args, env, timeoutMs).done;
}

/**
 * Like runRenderCli, but returns at once with the running process and its output so far. `detached` (POSIX): the CLI
 * gets its own process group, so a test can press Ctrl+C (SIGINT to the group) like a terminal does.
 */
export function startRenderCli(args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 150_000, opts: { detached?: boolean } = {}) {
  const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawn(process.execPath, [tsxCli, 'server/render-cli.ts', ...args], { env, detached: opts.detached });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise<CliResult>((resolve) => {
    const timer = setTimeout(() => {
      stderr += `\n[test] CLI render timed out after ${timeoutMs} ms`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  return { child, done, output: () => stdout + stderr };
}
