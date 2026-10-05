// Export test: 3-second 1080p project -> MP4 -> extract first, middle, last frames with ffmpeg ->
// compare to renderFrame output at the same timestamps (pixel diff below threshold).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { emptyProject, type Project } from '../../src/shared/schema';

const FIXTURE = path.resolve('tests/fixtures/fixture.png');
const WS = path.resolve('.e2e-workspace');

async function buildProject(request: APIRequestContext): Promise<Project> {
  const bytes = fs.readFileSync(FIXTURE);
  const up = await request.post('/api/assets', { data: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'fixture.png' } });
  const { hash } = await up.json();
  const p = emptyProject();
  p.settings = { durationSec: 3, aspect: '16:9', width: 1920, height: 1080, fps: 30, background: '#1b2340' };
  p.assets = [{ id: 'img1', originalName: 'fixture.png', relativePath: `assets/${hash.slice(0, 8)}-fixture.png`, type: 'image', hash, width: 320, height: 240 }];
  const base = { visible: true, locked: false, start: 0, duration: 3, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1 };
  p.scenes = [
    {
      id: 's1', name: 'Scene 1', start: 0, duration: 3,
      layers: [
        { ...base, id: 'r', name: 'Rect', type: 'shape', x: 400, y: 540, shape: 'rect', width: 400, height: 260, cornerRadius: 30, fill: '#ff7a3d', stroke: '#ffffff', strokeWidth: 6,
          keyframes: { x: [{ id: 'k1', time: 0, value: 300, easing: { type: 'easeInOut' } }, { id: 'k2', time: 3, value: 1600, easing: { type: 'linear' } }],
                       rotation: [{ id: 'k3', time: 0, value: 0, easing: { type: 'spring', stiffness: 120, damping: 10, mass: 1 } }, { id: 'k4', time: 2, value: 90, easing: { type: 'linear' } }] } },
        { ...base, id: 'i', name: 'Image', type: 'image', x: 1400, y: 300, assetId: 'img1', width: 320, height: 240, keyframes: {} },
        { ...base, id: 't', name: 'Title', type: 'text', x: 960, y: 860, content: 'Export test\nline two', fontFamily: 'Inter', fontSize: 96, fontWeight: 800, lineHeight: 1.1, letterSpacing: -1, align: 'center', color: '#ffffff',
          keyframes: { opacity: [{ id: 'k5', time: 0, value: 0, easing: { type: 'easeOut' } }, { id: 'k6', time: 1, value: 1, easing: { type: 'linear' } }] } },
        { ...base, id: 'c', name: 'Cursor', type: 'cursor', x: 0, y: 0, anchorX: 0, anchorY: 0, keyframes: {},
          points: [{ id: 'p1', x: 200, y: 200, time: 0 }, { id: 'p2', x: 1000, y: 500, time: 1.5 }, { id: 'p3', x: 1500, y: 300, time: 2.8 }],
          clicks: [{ id: 'c1', time: 1.5 }], smoothing: 0.6, size: 40, color: '#ffffff', rippleColor: '#ffffff66' },
      ],
    },
  ];
  return p;
}

function rgbFromVideo(file: string, frame: number): Buffer {
  return execFileSync('ffmpeg', [
    '-loglevel', 'error', '-i', file,
    '-vf', `select=eq(n\\,${frame}),scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
}

function rgbFromPng(file: string): Buffer {
  return execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
}

function diff(a: Buffer, b: Buffer) {
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

function probe(file: string) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,pix_fmt,nb_read_frames,r_frame_rate', '-of', 'json', file]).toString();
  return JSON.parse(out).streams[0];
}

test('MP4 export matches renderFrame at first, middle and last frame', async ({ page, request }) => {
  const project = await buildProject(request);
  const name = `Export ${Date.now()}`;
  expect((await request.put(`/api/projects/${encodeURIComponent(name)}`, { data: project })).ok()).toBe(true);

  // Export through the same API the Export button uses.
  const start = await request.post('/api/export', { data: { project, name } });
  expect(start.ok()).toBe(true);
  let job = await start.json();
  await expect
    .poll(async () => (job = await (await request.get(`/api/jobs/${job.id}`)).json()).status, { timeout: 120_000, intervals: [250] })
    .toBe('done');
  const mp4 = job.outFile as string;
  const info = probe(mp4);
  expect(info).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', nb_read_frames: '90', r_frame_rate: '30/1' });
  // faststart: the moov atom comes before mdat.
  const head = fs.readFileSync(mp4).subarray(0, 4096).toString('latin1');
  expect(head.indexOf('moov')).toBeGreaterThan(-1);

  await page.goto('/render.html');
  await expect(page).toHaveTitle('render-ready');
  for (const frame of [0, 45, 89]) {
    const t = frame / 30;
    const { png } = await page.evaluate(({ p, t, name }) => (window as any).motion.render(p, t, { projectName: name }), { p: project, t, name });
    const pngFile = test.info().outputPath(`render-${frame}.png`);
    fs.writeFileSync(pngFile, Buffer.from(png.split(',')[1], 'base64'));
    const expected = rgbFromPng(pngFile);
    const actual = rgbFromVideo(mp4, frame);
    const d = diff(expected, actual);
    console.log(`frame ${frame} (t=${t.toFixed(3)}s): mean abs diff ${d.meanAbs.toFixed(3)}, PSNR ${d.psnr.toFixed(2)} dB`);
    expect(d.meanAbs).toBeLessThan(1.5);
    expect(d.psnr).toBeGreaterThan(36);
    // And it really is the right moment: a different frame differs much more.
    const wrong = diff(expected, rgbFromVideo(mp4, frame === 0 ? 89 : 0));
    expect(wrong.meanAbs).toBeGreaterThan(d.meanAbs * 2);
  }
});

test('CLI render produces the same video, and reports missing ffmpeg clearly', async ({ request }) => {
  const project = await buildProject(request);
  const name = `CLI ${Date.now()}`;
  expect((await request.put(`/api/projects/${encodeURIComponent(name)}`, { data: project })).ok()).toBe(true);
  const out = test.info().outputPath('cli.mp4');
  const r = spawnSync('npx', ['tsx', 'server/render-cli.ts', path.join(WS, `${name}.motion`), out], { encoding: 'utf8', timeout: 150_000 });
  expect(r.status, r.stderr + r.stdout).toBe(0);
  expect(probe(out)).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, nb_read_frames: '90' });

  const missing = spawnSync('npx', ['tsx', 'server/render-cli.ts', path.join(WS, `${name}.motion`), out], {
    encoding: 'utf8',
    env: { ...process.env, FFMPEG_PATH: '/definitely/not/ffmpeg' },
  });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('ffmpeg was not found');
  expect(missing.stderr).toContain('winget install');
});

test('export can be cancelled', async ({ request }) => {
  const project = await buildProject(request);
  project.settings = { ...project.settings, durationSec: 20, width: 3840, height: 2160 };
  const start = await request.post('/api/export', { data: { project } });
  let job = await start.json();
  await expect.poll(async () => (job = await (await request.get(`/api/jobs/${job.id}`)).json()).frame, { timeout: 60_000 }).toBeGreaterThan(2);
  job = await (await request.post(`/api/jobs/${job.id}/cancel`)).json();
  expect(job.status).toBe('cancelled');
  await expect.poll(() => fs.existsSync(job.outFile), { timeout: 10_000 }).toBe(false);
  const later = await (await request.get(`/api/jobs/${job.id}`)).json();
  expect(later.status).toBe('cancelled');
  expect(later.frame).toBeLessThan(later.total);
});
