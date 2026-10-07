// B3: export options (Size / Quality / Include audio) through the dialog, the API and the CLI; scaled exports compared
// with renderFrame at the same output size; the PNG still; "Make a copy in another format".
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { expect, test, type Page } from '@playwright/test';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { aspectOf } from '../../src/shared/fitToFrame';
import { emptyProject, type Asset, type CursorLayer, type Layer, type Project, type TextLayer } from '../../src/shared/schema';
import { makeWav, streams } from './app-audio-helpers';
import { store } from './app-ui-helpers';
import { expectExportMatchesRender, pixelDiff, probe, renderPng, rgbFromPng, runExport, runRenderCli, saveProject, uploadAsset, WS } from './exportCompare';
import { getState, past } from './helpers';

const FIXTURE = path.resolve('tests/fixtures/fixture.png');

/**
 * width×height, 30 fps: a stroked rectangle moving across (so frame timing is checkable), a two-line title fading in,
 * an optional image and a cursor with a click. Sizes are relative to the short edge so every format looks alike.
 */
function movingProject(width: number, height: number, opts: { seconds?: number; image?: Asset } = {}): Project {
  const d = opts.seconds ?? 1;
  const u = Math.min(width, height) / 100;
  const base = { visible: true, locked: false, start: 0, duration: d, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1 };
  const lin = { type: 'linear' as const };
  const layers: Layer[] = [
    makeLayer({
      ...base, id: 'rect', name: 'Rect', type: 'shape', x: width * 0.2, y: height * 0.4, shape: 'rect', width: 24 * u, height: 14 * u, cornerRadius: 3 * u,
      fill: '#ff7a3d', stroke: '#ffffff', strokeWidth: u,
      keyframes: {
        x: [{ id: 'kx1', time: 0, value: width * 0.2, easing: { type: 'easeInOut' } }, { id: 'kx2', time: d, value: width * 0.8, easing: lin }],
        rotation: [{ id: 'kr1', time: 0, value: 0, easing: lin }, { id: 'kr2', time: d, value: 45, easing: lin }],
      },
    }),
    makeLayer({
      ...base, id: 'title', name: 'Title', type: 'text', x: width / 2, y: height * 0.72, scale: 1.25, content: 'Scaled export\nstays sharp', fontFamily: 'Inter', fontSize: 7 * u,
      fontWeight: 800, lineHeight: 1.1, letterSpacing: 0, align: 'center', color: '#ffffff',
      keyframes: { opacity: [{ id: 'ko1', time: 0, value: 0.2, easing: { type: 'easeOut' } }, { id: 'ko2', time: d / 2, value: 1, easing: lin }] },
    }),
    makeLayer({
      ...base, id: 'cursor', name: 'Cursor', type: 'cursor', x: 0, y: 0, anchorX: 0, anchorY: 0, keyframes: {},
      points: [{ id: 'p1', x: width * 0.3, y: height * 0.8, time: 0 }, { id: 'p2', x: width * 0.6, y: height * 0.3, time: d * 0.6 }],
      clicks: [{ id: 'c1', time: d * 0.6 }], smoothing: 0.5, size: 5 * u, color: '#ffffff', rippleColor: '#ffffff66',
    }),
  ];
  if (opts.image) layers.splice(1, 0, makeLayer({ ...base, id: 'img', name: 'Image', type: 'image', x: width * 0.72, y: height * 0.28, scale: 0.9, assetId: opts.image.id, width: 32 * u, height: 24 * u, keyframes: {} }));
  return makeProject({
    ...emptyProject(),
    settings: { durationSec: d, aspect: aspectOf(width, height), width, height, fps: 30, background: '#1b2340' },
    assets: opts.image ? [opts.image] : [],
    scenes: [{ id: 's1', name: 'Scene 1', start: 0, duration: d, layers }],
  });
}

const fixtureAsset = async (request: Parameters<typeof uploadAsset>[0]): Promise<Asset> => {
  const { hash } = await uploadAsset(request, FIXTURE);
  return { id: 'img1', originalName: 'fixture.png', relativePath: `assets/${hash.slice(0, 8)}-fixture.png`, type: 'image', hash, width: 320, height: 240 };
};

/** Open a project in the editor (as if opened under `name`, which need not exist on disk). */
const loadInEditor = (page: Page, project: Project, name: string | null) =>
  page.evaluate(({ p, name }) => (window as any).__motion.useEditor.getState().loadProject(p, name), { p: project, name });

/** The x264 settings in a video: libx264 writes them into the H.264 stream (e.g. "crf=26.0", "subme=2"). */
function x264(file: string): Record<string, string> {
  const bytes = fs.readFileSync(file).toString('latin1');
  const at = bytes.indexOf('x264 - core');
  expect(at, 'x264 settings in the stream').toBeGreaterThan(-1);
  return Object.fromEntries([...bytes.slice(at, bytes.indexOf('\0', at)).matchAll(/ (\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
}

const STAMP = '\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d';

test('Export dialog: Size with live pixel sizes, Quality, Include audio; choices are remembered; the file is name-WxH-stamp.mp4', async ({ page }) => {
  const name = `Opts ${Date.now()}`;
  await page.goto('/');
  await loadInEditor(page, movingProject(1366, 768, { seconds: 0.5 }), name);
  await page.getByTestId('btn-export').click();
  const size = page.getByTestId('export-size');
  const quality = page.getByTestId('export-quality');
  const audio = page.getByTestId('export-audio');
  await expect(size.locator('option')).toHaveText(['100% — 1366×768', '50% — 684×384', '25% — 342×192 (quick check)']);
  await expect(quality.locator('option')).toHaveText(['Best (larger file)', 'Good', 'Draft (fastest)']);
  await expect(size).toHaveValue('1');
  await expect(quality).toHaveValue('best');
  // No audio clips: the box is off and disabled, and says why.
  await expect(audio).toBeDisabled();
  await expect(audio).not.toBeChecked();
  await expect(page.getByTestId('export-no-audio')).toContainText('No audio clips');
  // The sizes are live: they follow the project size (a 4K project here).
  await store(page, 's.commit((d) => { d.settings.width = 3840; d.settings.height = 2160; })');
  await expect(size.locator('option')).toHaveText(['100% — 3840×2160', '50% — 1920×1080 (Full HD)', '25% — 960×540 (quick check)']);
  await store(page, 's.undo()');
  await expect(size.locator('option').nth(1)).toHaveText('50% — 684×384');

  await size.selectOption('0.5');
  await quality.selectOption('draft');
  await expect(page.getByTestId('export-summary')).toContainText(`684×384, 30 fps, 0.5 s — H.264 MP4 (CRF 26). File: ${name}-684x384-‹date›.mp4`);
  await expect(page.getByTestId('export-cli')).toContainText(`"${name}.mp4" --scale 0.5 --crf 26 --preset veryfast`);
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-status')).toContainText('done — frame 15/15', { timeout: 60_000 });
  const file = (await page.getByTestId('export-file').textContent())!;
  expect(path.basename(file)).toMatch(new RegExp(`^${name}-684x384-${STAMP}\\.mp4$`));
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()]);
  expect(download.suggestedFilename()).toBe(path.basename(file));
  // The video has the chosen size and the Draft encoder settings.
  expect(probe(file)).toMatchObject({ width: 684, height: 384, nb_read_frames: '15', pix_fmt: 'yuv420p' });
  expect(x264(file)).toMatchObject({ crf: '26.0', subme: '2', rc_lookahead: '10' });

  // Remembered when the dialog opens again, and after a reload.
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('btn-export').click();
  await expect(size).toHaveValue('0.5');
  await expect(quality).toHaveValue('draft');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByTestId('btn-export').click();
  await expect(size).toHaveValue('0.5');
  await expect(quality).toHaveValue('draft');
  // The 25% label of the default (4K) project.
  await expect(size.locator('option').nth(2)).toHaveText('25% — 960×540 (quick check)');
  await page.keyboard.press('Escape');

  // With a sound clip, Include audio is available and on; unticking it is remembered too.
  await page.getByTestId('file-input').setInputFiles(makeWav(test.info().outputPath('beep.wav'), { expr: '0.3*sin(2*PI*440*t)', seconds: 0.5 }));
  await expect(page.getByTestId('audio-row-0')).toBeVisible();
  await page.getByTestId('btn-export').click();
  await expect(audio).toBeEnabled();
  await expect(audio).toBeChecked();
  await expect(page.getByTestId('export-no-audio')).toHaveCount(0);
  const summary = page.getByTestId('export-summary');
  await expect(summary).toContainText('(CRF 26). File:');
  // Unticked while the project has sound: the summary says so (the choice is remembered, so it must stay visible).
  await audio.uncheck();
  await expect(summary).toContainText('(CRF 26), without sound. File:');
  await page.keyboard.press('Escape');
  await page.getByTestId('btn-export').click();
  await expect(audio).not.toBeChecked();
  await expect(summary).toContainText('without sound');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('motion-studio.prefs')!))).toMatchObject({ exportScale: 0.5, exportQuality: 'draft', exportAudio: false });
});

test('scaled exports have the exact even size and match renderFrame at that size (50%, 25%, odd halves)', async ({ page, request }) => {
  const image = await fixtureAsset(request);
  for (const c of [
    { width: 1080, height: 1350, scale: 0.5, w: 540, h: 676 },
    { width: 1366, height: 768, scale: 0.5, w: 684, h: 384 },
    { width: 1920, height: 1080, scale: 0.25, w: 480, h: 270 },
  ]) {
    const project = movingProject(c.width, c.height, { image });
    const name = `Scaled ${c.width}x${c.height} ${Date.now()}`;
    const job = await runExport(request, { project, name, scale: c.scale }, 60_000);
    expect(job).toMatchObject({ width: c.w, height: c.h });
    expect(path.basename(job.outFile)).toMatch(new RegExp(`^${name}-${c.w}x${c.h}-${STAMP}\\.mp4$`));
    expect(probe(job.outFile)).toMatchObject({ width: c.w, height: c.h, nb_read_frames: '30', pix_fmt: 'yuv420p' });
    // What the render page was told: the output size and the scale that fills it (max(outW/W, outH/H), not 0.5).
    const sent = await (await request.get(`/api/jobs/${job.id}/project`)).json();
    expect([sent.outW, sent.outH, sent.scale]).toEqual([c.w, c.h, Math.max(c.w / c.width, c.h / c.height)]);
    console.log(`${c.width}x${c.height} @ ${c.scale * 100}% -> ${c.w}x${c.h} (scale ${sent.scale})`);
    // Small frames: 4:2:0 chroma loss on sharp edges caps the PSNR (a single-frame encode of the render itself gives
    // 35.2–35.7 dB here), while a 0.07% scale error already drops to 27.6 dB — 34 dB still catches any mismatch.
    await expectExportMatchesRender(page, { project, projectName: name, mp4: job.outFile, frames: [0, 15, 29], wrongFrame: (f) => (f === 0 ? 29 : 0), exportScale: c.scale, minPsnr: 34 });
  }
});

test('quality and Include audio reach ffmpeg (x264 settings in the stream, audio track or not); bad options are refused', async ({ request }) => {
  const wav = makeWav(test.info().outputPath('tone.wav'), { expr: '0.4*sin(2*PI*440*t)', seconds: 1 });
  const { hash } = await uploadAsset(request, wav);
  const project = movingProject(320, 180);
  project.assets.push({ id: 'tone', originalName: 'tone.wav', relativePath: `assets/${hash.slice(0, 8)}-tone.wav`, type: 'audio', hash, duration: 1 });
  project.audio.push({ id: 'clip', name: 'tone', assetId: 'tone', start: 0, trimStart: 0, duration: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false });

  // No options: Best (CRF 16, medium) with audio — what lane A's and the older tests rely on.
  const best = await runExport(request, { project }, 60_000);
  expect(best.options).toEqual({ scale: 1, crf: 16, preset: 'medium', audio: true });
  expect(x264(best.outFile)).toMatchObject({ crf: '16.0', subme: '7', rc_lookahead: '40' });
  expect(streams(best.outFile).map((s) => s.codec_type)).toEqual(['video', 'audio']);

  const good = await runExport(request, { project, crf: 20 }, 60_000);
  expect(x264(good.outFile)).toMatchObject({ crf: '20.0', subme: '7' });
  expect(fs.statSync(good.outFile).size).toBeLessThan(fs.statSync(best.outFile).size);

  const draft = await runExport(request, { project, crf: 26, preset: 'veryfast', audio: false }, 60_000);
  expect(x264(draft.outFile)).toMatchObject({ crf: '26.0', subme: '2', rc_lookahead: '10' });
  expect(streams(draft.outFile).map((s) => s.codec_type)).toEqual(['video']);
  expect(draft.warnings).toEqual([]);
  // ~1 s each: consecutive exports often start in the same second, yet each gets its own file.
  expect(new Set([best.outFile, good.outFile, draft.outFile]).size).toBe(3);

  // Two exports started together (same name, size and second) write two files; neither overwrites the other.
  const tiny = movingProject(160, 90, { seconds: 0.5 });
  const [one, two] = await Promise.all([runExport(request, { project: tiny }, 60_000), runExport(request, { project: tiny }, 60_000)]);
  expect(one.outFile).not.toBe(two.outFile);
  for (const j of [one, two]) {
    expect(path.basename(j.outFile)).toMatch(new RegExp(`^untitled-160x90-${STAMP}(-2)?\\.mp4$`));
    expect(probe(j.outFile)).toMatchObject({ width: 160, height: 90, nb_read_frames: '15' });
  }

  const bad = await request.post('/api/export', { data: { project, scale: 2, crf: 'high' } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toBe('Invalid export options: scale must be more than 0 and at most 1 (e.g. 0.5, or 50%); crf must be a whole number from 0 (best) to 51 (smallest file)');
});

test('CLI flags --scale, --crf, --preset and --no-audio; a bad flag prints what is wrong and the usage', async ({ request }) => {
  const wav = makeWav(test.info().outputPath('tone.wav'), { expr: '0.4*sin(2*PI*440*t)', seconds: 1 });
  const { hash } = await uploadAsset(request, wav);
  const project = movingProject(320, 180);
  project.assets.push({ id: 'tone', originalName: 'tone.wav', relativePath: `assets/${hash.slice(0, 8)}-tone.wav`, type: 'audio', hash, duration: 1 });
  project.audio.push({ id: 'clip', name: 'tone', assetId: 'tone', start: 0, trimStart: 0, duration: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false });
  const name = `CLI flags ${Date.now()}`;
  const dir = await saveProject(request, name, project);

  const out = test.info().outputPath('cli-flags.mp4');
  const r = await runRenderCli([dir, out, '--scale', '50%', '--crf', '26', '--preset=veryfast', '--no-audio']);
  expect(r.status, r.stderr + r.stdout).toBe(0);
  expect(r.stdout).toContain(`Rendering 30 frames at 160x90 (50% of 320x180) @ 30fps, CRF 26 (veryfast), no audio -> ${out}`);
  expect(probe(out)).toMatchObject({ width: 160, height: 90, nb_read_frames: '30' });
  expect(x264(out)).toMatchObject({ crf: '26.0', subme: '2' });
  expect(streams(out).map((s) => s.codec_type)).toEqual(['video']);

  const bad = await runRenderCli([dir, out, '--scale', '50']);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('--scale must be more than 0 and at most 1 (e.g. 0.5, or 50%)');
  expect(bad.stderr).toContain('Usage: npm run render -- <projectFolder.motion> <out.mp4> [options]');
});

test('PNG button: the current frame at full project size, named name-WxH-frameN.png, identical to render.html', async ({ page, request }) => {
  const project = movingProject(1280, 720, { seconds: 3, image: await fixtureAsset(request) });
  const name = `Still ${Date.now()}`;
  await page.goto('/');
  await loadInEditor(page, project, name);
  // Between frames 45 and 46: the still is frame 45, rendered at exactly 45/30 s like the export's frame 45.
  await store(page, 's.setTime(1.51)');
  await expect(page.getByTestId('frame-counter')).toHaveText('frame 45 / 89');
  await expect(page.getByTestId('btn-png')).toHaveAttribute('title', 'Save this frame as a PNG image at full size (1280×720)');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('btn-png').click()]);
  expect(download.suggestedFilename()).toBe(`${name}-1280x720-frame45.png`);
  await expect(page.locator('.toast').filter({ hasText: `Saved frame 45 as ${name}-1280x720-frame45.png` })).toBeVisible();
  const file = test.info().outputPath('still.png');
  await download.saveAs(file);
  expect(probe(file)).toMatchObject({ codec_name: 'png', width: 1280, height: 720 });

  const expected = await renderPng(page, project, 45 / 30, name, 'render-45.png');
  const d = pixelDiff(rgbFromPng(expected), rgbFromPng(file));
  console.log(`PNG still vs render.html: mean abs diff ${d.meanAbs.toFixed(4)}, PSNR ${d.psnr.toFixed(2)} dB`);
  expect(d.meanAbs).toBeLessThan(0.01);
  // And it really is frame 45, not the neighbouring frame.
  const next = pixelDiff(rgbFromPng(await renderPng(page, project, 46 / 30, name, 'render-46.png')), rgbFromPng(file));
  expect(next.meanAbs).toBeGreaterThan(0.05);
});

/** A small PNG with a colour and size nobody else uses, so its bytes are in no scratch store yet. */
function uniquePng(file: string): Buffer {
  const n = Date.now();
  const colour = (n % 0xffffff).toString(16).padStart(6, '0');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${colour}:s=${64 + (n % 31) * 2}x48`, '-frames:v', '1', file]);
  return fs.readFileSync(file);
}

test('Make a copy in another format: 9:16 → Save as "<name> 9x16" → the copy opens with every layer fitted, its assets come along', async ({ page, request }) => {
  // A project imported from a .zip: its image exists only in the project folder, not in the scratch store.
  const name = `Fmt ${Date.now()}`;
  const bytes = uniquePng(test.info().outputPath('logo.png'));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const asset: Asset = { id: 'logo', originalName: 'logo.png', relativePath: `assets/${hash.slice(0, 8)}-logo.png`, type: 'image', hash, width: 64, height: 48 };
  const project = movingProject(1920, 1080, { image: asset });
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify(project)));
  zip.addFile(asset.relativePath, bytes);
  const imported = await request.post('/api/import-zip', { data: zip.toBuffer(), headers: { 'Content-Type': 'application/zip', 'X-Filename': encodeURIComponent(`${name}.zip`) } });
  expect(imported.ok(), await imported.text()).toBe(true);
  expect(fs.readdirSync(path.join(WS, '.scratch')).some((f) => f.startsWith(hash))).toBe(false);

  await page.goto('/');
  await page.getByTestId('btn-open').click();
  await page.getByTestId(`open-${name}`).click();
  await expect(page).toHaveTitle(new RegExp(`^${name}`));
  await expect.poll(async () => (await getState(page)).missing).toEqual([]);
  // An unsaved edit: it goes into the copy, and the dialog says the original keeps its saved version.
  await store(page, "s.commit((d) => { d.scenes[0].layers.find((l) => l.id === 'title').content = 'Changed'; })");

  // Cancel changes nothing.
  await page.getByTestId('format-copy').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('doc-name')).toContainText(name);

  await page.getByTestId('format-copy').click();
  await expect(page.getByTestId('format-option-16x9')).toBeDisabled();
  await expect(page.getByTestId('format-option-16x9')).toContainText('current format');
  await expect(page.getByTestId('format-option-9x16')).toContainText('1080×1920');
  await expect(page.getByTestId('format-option-1x1')).toContainText('1920×1920');
  await expect(page.getByTestId('format-option-4x5')).toContainText('1536×1920');
  await expect(page.getByTestId('format-copy-unsaved')).toContainText(`"${name}" has unsaved changes`);
  await page.getByTestId('format-option-9x16').click();
  await expect(page.getByRole('dialog', { name: 'Save the 9:16 copy as' })).toBeVisible();
  await expect(page.getByTestId('save-name')).toHaveValue(`${name} 9x16`);
  await page.getByTestId('save-confirm').click();
  await expect(page.getByTestId('doc-name')).toHaveText(`${name} 9x16`);
  await expect(page.getByTestId('dirty-dot')).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: `Opened the 9:16 copy "${name} 9x16"` })).toBeVisible();
  expect(await past(page)).toBe(0);

  // Every layer is mapped like the frame: k = min(1080/1920, 1920/1080) = 0.5625, centred.
  const st = await getState(page);
  expect(st.project.settings).toMatchObject({ width: 1080, height: 1920, aspect: '9:16' });
  const k = 0.5625;
  const fx = (x: number) => 540 + k * (x - 960);
  const fy = (y: number) => 960 + k * (y - 540);
  const now = Object.fromEntries(st.project.scenes[0].layers.map((l) => [l.id, l]));
  const was = Object.fromEntries(project.scenes[0].layers.map((l) => [l.id, l]));
  for (const id of ['rect', 'img', 'title', 'cursor']) {
    expect(now[id].x).toBeCloseTo(fx(was[id].x), 6);
    expect(now[id].y).toBeCloseTo(fy(was[id].y), 6);
    expect(now[id].scale).toBeCloseTo(was[id].scale * k, 9);
  }
  now.rect.keyframes.x.forEach((kf, i) => expect(kf.value).toBeCloseTo(fx(Number(was.rect.keyframes.x[i].value)), 6));
  expect(now.rect.keyframes.rotation.map((kf) => kf.value)).toEqual([0, 45]);
  (now.cursor as CursorLayer).points.forEach((p, i) => {
    expect(p.x).toBeCloseTo(fx((was.cursor as CursorLayer).points[i].x), 6);
    expect(p.y).toBeCloseTo(fy((was.cursor as CursorLayer).points[i].y), 6);
  });
  expect((now.title as TextLayer).content).toBe('Changed');

  // Saved with its image (byte-for-byte), which loads in the copy.
  const copyDir = path.join(WS, `${name} 9x16.motion`);
  expect(JSON.parse(fs.readFileSync(path.join(copyDir, 'project.json'), 'utf8')).settings).toMatchObject({ width: 1080, height: 1920 });
  expect(fs.readFileSync(path.join(copyDir, asset.relativePath)).equals(bytes)).toBe(true);
  await expect.poll(async () => (await getState(page)).missing).toEqual([]);
  // The original is untouched on disk.
  const original = JSON.parse(fs.readFileSync(path.join(WS, `${name}.motion`, 'project.json'), 'utf8')) as Project;
  expect(original.settings).toMatchObject({ width: 1920, height: 1080 });
  expect((original.scenes[0].layers.find((l) => l.id === 'title') as TextLayer).content).toBe('Scaled export\nstays sharp');
});
