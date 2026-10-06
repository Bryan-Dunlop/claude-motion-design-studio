// Export test: 3-second 1080p project -> MP4 -> extract first, middle, last frames with ffmpeg ->
// compare to renderFrame output at the same timestamps (pixel diff below threshold).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { emptyProject, ProjectSchema, type Project, type ProjectInput } from '../../src/shared/schema';
import { expectExportMatchesRender, probe, runExport, runRenderCli, saveProject, uploadAsset, WS } from './exportCompare';

const FIXTURE = path.resolve('tests/fixtures/fixture.png');

async function buildProject(request: APIRequestContext): Promise<Project> {
  const { hash } = await uploadAsset(request, FIXTURE);
  const p: ProjectInput = emptyProject();
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
  return ProjectSchema.parse(p);
}

test('MP4 export matches renderFrame at first, middle and last frame', async ({ page, request }) => {
  const project = await buildProject(request);
  const name = `Export ${Date.now()}`;
  await saveProject(request, name, project);

  // Export through the same API the Export button uses.
  const job = await runExport(request, { project, name });
  const mp4 = job.outFile;
  const info = probe(mp4);
  expect(info).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', nb_read_frames: '90', r_frame_rate: '30/1' });
  // faststart: the moov atom comes before mdat.
  const head = fs.readFileSync(mp4).subarray(0, 4096).toString('latin1');
  expect(head.indexOf('moov')).toBeGreaterThan(-1);

  await expectExportMatchesRender(page, { project, projectName: name, mp4, frames: [0, 45, 89], wrongFrame: (f) => (f === 0 ? 89 : 0) });
});

test('CLI render produces the same video, and reports missing ffmpeg clearly', async ({ page, request }) => {
  const project = await buildProject(request);
  const name = `CLI ${Date.now()}`;
  await saveProject(request, name, project);
  const out = test.info().outputPath('cli.mp4');
  // A fresh workspace: the image must come from the project folder itself, not the editor's store.
  const r = await runRenderCli([path.join(WS, `${name}.motion`), out], { ...process.env, MOTION_WORKSPACE: test.info().outputPath('cli-ws') });
  expect(r.status, r.stderr + r.stdout).toBe(0);
  expect(r.stderr).not.toContain('Warning');
  expect(probe(out)).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, nb_read_frames: '90' });
  await expectExportMatchesRender(page, { project, projectName: name, mp4: out, frames: [0, 45, 89], wrongFrame: (f) => (f === 0 ? 89 : 0) });

  const missing = await runRenderCli([path.join(WS, `${name}.motion`), out], { ...process.env, FFMPEG_PATH: '/definitely/not/ffmpeg' });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('ffmpeg was not found');
  expect(missing.stderr).toContain('winget install');
});

test('a missing image is exported as a placeholder, with a warning from the CLI', async ({ request }) => {
  const project = await buildProject(request);
  const name = `CLI missing ${Date.now()}`;
  const dir = await saveProject(request, name, project);
  fs.rmSync(path.join(dir, project.assets[0].relativePath));
  const r = await runRenderCli([dir, test.info().outputPath('missing.mp4')], { ...process.env, MOTION_WORKSPACE: test.info().outputPath('cli-ws') });
  expect(r.status, r.stderr + r.stdout).toBe(0);
  expect(r.stderr).toContain('Warning: Image missing: fixture.png — exported with a placeholder.');
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
