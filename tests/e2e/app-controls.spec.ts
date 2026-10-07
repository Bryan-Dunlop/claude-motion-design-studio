// Controls the README promises that no other test presses: Home, the Redo and Replay buttons, Ctrl+wheel zoom, the
// close-tab warning, dropping files onto the preview, Ctrl+Shift+S, and the Export dialog's Include audio box, Cancel
// button and "ffmpeg missing" help. Also what Save, Open and the Export dialog say when Motion Studio's server has
// stopped (its window was closed).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { makeProject } from '../../src/shared/factories';
import { emptyProject, type Project } from '../../src/shared/schema';
import { makeWav, streams } from './app-audio-helpers';
import { editor, setTime, shortcut, toast } from './app-ui-helpers';
import { WS } from './exportCompare';
import { getState } from './helpers';

const small = (seconds: number, width = 320, height = 180): Project =>
  makeProject({ ...emptyProject(), settings: { durationSec: seconds, aspect: 'custom', width, height, fps: 30, background: '#14213d' } });
const load = (page: Page, p: Project) => page.evaluate((p) => (window as any).__motion.useEditor.getState().loadProject(p, null), p);

test('Home goes to the start; the toolbar Redo button redoes; Replay plays from the start', async ({ page }) => {
  await page.goto('/');
  await setTime(page, 2);
  await page.keyboard.press('Home');
  expect((await editor(page)).time).toBe(0);

  await page.getByTestId('add-rect').click();
  await page.getByTestId('btn-undo').click();
  expect((await getState(page)).project.scenes.flatMap((s) => s.layers)).toHaveLength(0);
  await page.getByTestId('btn-redo').click();
  expect((await getState(page)).project.scenes.flatMap((s) => s.layers)).toHaveLength(1);

  await setTime(page, 5);
  await page.getByTitle('Replay from the start').click();
  const playing = () => page.evaluate(() => (window as any).__motion.useEditor.getState().playing as boolean);
  expect(await playing()).toBe(true);
  expect((await editor(page)).time).toBeLessThan(2);
  await page.getByTestId('btn-play').click();
});

test('Ctrl + mouse wheel zooms the timeline (and only the timeline, not the whole page)', async ({ page }) => {
  await page.goto('/');
  const zoom0 = (await editor(page)).zoom;
  const prevented = await page.locator('.timeline').evaluate((el) => {
    const e = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(true);
  expect((await editor(page)).zoom).toBeCloseTo(zoom0 * 1.15, 6);
  // A plain wheel scrolls as usual.
  const plain = await page.locator('.timeline').evaluate((el) => {
    const e = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(plain).toBe(false);
  expect((await editor(page)).zoom).toBeCloseTo(zoom0 * 1.15, 6);
});

test('closing the tab with unsaved changes asks first; with none it does not', async ({ page, context }) => {
  await page.goto('/');
  let asked = false;
  page.on('dialog', (d) => {
    asked = d.type() === 'beforeunload';
    void d.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(asked).toBe(false);

  const dirty = await context.newPage();
  await dirty.goto('/');
  await dirty.getByTestId('add-rect').click();
  dirty.on('dialog', (d) => {
    asked = d.type() === 'beforeunload';
    void d.dismiss(); // stay on the page
  });
  await dirty.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);
  expect(dirty.isClosed()).toBe(false);
});

test('dropping an image and a sound onto the preview imports both: a picture layer and a sound clip', async ({ page }) => {
  await page.goto('/');
  const png = [...fs.readFileSync('tests/fixtures/fixture.png')];
  const wav = [...fs.readFileSync(makeWav(test.info().outputPath('drop.wav'), { expr: '0.3*sin(2*PI*440*t)', seconds: 0.5 }))];
  const files = await page.evaluateHandle(({ png, wav }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(png)], 'dropped logo.png', { type: 'image/png' }));
    dt.items.add(new File([new Uint8Array(wav)], 'dropped beep.wav', { type: 'audio/wav' }));
    return dt;
  }, { png, wav });
  const preview = page.getByTestId('preview-canvas');
  await preview.dispatchEvent('dragover', { dataTransfer: files });
  await expect(page.locator('.preview.drag-over')).toHaveCount(1);
  await preview.dispatchEvent('drop', { dataTransfer: files });
  await expect.poll(async () => (await getState(page)).project.assets.map((a) => [a.type, a.originalName])).toEqual([['image', 'dropped logo.png'], ['audio', 'dropped beep.wav']]);
  const p = (await getState(page)).project;
  expect(p.scenes.flatMap((s) => s.layers).map((l) => [l.type, (l as { assetId?: string }).assetId])).toEqual([['image', p.assets[0].id]]);
  expect(p.audio.map((c) => c.assetId)).toEqual([p.assets[1].id]);
  await expect(page.locator('.preview.drag-over')).toHaveCount(0);
});

test('Ctrl+Shift+S saves under a new name (Save as) and carries on with that project', async ({ page }) => {
  const first = `Save as A ${Date.now()}`;
  const second = `Save as B ${Date.now()}`;
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await shortcut(page, 'Control+s');
  await page.getByTestId('save-name').fill(first);
  await page.getByTestId('save-confirm').click();
  await toast(page, `Saved ${first}.motion`);
  await page.getByTestId('add-text').click();
  await shortcut(page, 'Control+Shift+s');
  await page.getByTestId('save-name').fill(second);
  await page.getByTestId('save-confirm').click();
  await toast(page, `Saved ${second}.motion`);
  expect((await getState(page)).name).toBe(second);
  const layers = (name: string) => JSON.parse(fs.readFileSync(path.join(WS, `${name}.motion`, 'project.json'), 'utf8')).scenes.flatMap((s: { layers: { type: string }[] }) => s.layers.map((l) => l.type));
  expect(layers(first)).toEqual(['shape']);
  expect(layers(second)).toEqual(['shape', 'text']);
});

test('the Export dialog explains how to install ffmpeg when it is missing, and cannot start', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({ json: { ffmpeg: false, ffmpegHelp: 'ffmpeg was not found on your PATH (test)', workspace: '/tmp' } }));
  await page.goto('/');
  await page.getByTestId('btn-export').click();
  await expect(page.getByTestId('ffmpeg-missing')).toContainText('ffmpeg was not found on your PATH (test)');
  await expect(page.getByTestId('export-start')).toBeDisabled();
});

test("the Export dialog's Include audio box decides whether the MP4 has sound", async ({ page }) => {
  await page.goto('/');
  await load(page, small(0.5));
  await page.getByTestId('file-input').setInputFiles(makeWav(test.info().outputPath('beep.wav'), { expr: '0.3*sin(2*PI*440*t)', seconds: 0.5 }));
  await expect(page.getByTestId('audio-row-0')).toBeVisible();
  for (const withSound of [false, true]) {
    await page.getByTestId('btn-export').click();
    const box = page.getByTestId('export-audio');
    if (withSound) await box.check();
    else await box.uncheck();
    await page.getByTestId('export-start').click();
    await expect(page.getByTestId('export-status')).toContainText('done', { timeout: 60_000 });
    const file = (await page.getByTestId('export-file').textContent())!;
    expect(streams(file).map((s) => s.codec_type), `Include audio ${withSound}`).toEqual(withSound ? ['video', 'audio'] : ['video']);
    await page.keyboard.press('Escape');
  }
});

test('Cancel export in the dialog stops the export and leaves no unfinished file', async ({ page }) => {
  const exportsDir = path.join(WS, 'exports');
  const before = new Set(fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : []);
  await page.goto('/');
  await load(page, small(30, 1280, 720));
  await page.getByTestId('btn-export').click();
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-status')).toContainText(/rendering .*frame \d+/, { timeout: 60_000 });
  await expect.poll(async () => Number(/frame (\d+)/.exec((await page.getByTestId('export-status').textContent()) ?? '')?.[1] ?? 0)).toBeGreaterThan(3);
  await page.getByTestId('export-cancel').click();
  await expect(page.getByTestId('export-status')).toContainText('cancelled');
  await expect.poll(() => fs.readdirSync(exportsDir).filter((f) => !before.has(f)), { timeout: 10_000 }).toEqual([]);
});

const SERVER_GONE = "Motion Studio isn't running any more (was its window closed?). Start it again, then try again: nothing in this tab is lost.";

test('Save with the server stopped says so plainly, and the work stays in the tab', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await shortcut(page, 'Control+s');
  await page.getByTestId('save-name').fill(`Server gone ${Date.now()}`);
  await page.getByTestId('save-confirm').click();
  await toast(page, `Save failed: ${SERVER_GONE}`);
  expect((await getState(page)).project.scenes.flatMap((s) => s.layers)).toHaveLength(1);
});

test('the Open dialog shows where projects are saved, and says so plainly when the server has stopped', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('btn-open').click();
  await expect(page.getByTestId('open-folder')).toHaveText(`Projects are saved in ${path.resolve(WS)}`);
  await page.keyboard.press('Escape');
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await page.getByTestId('btn-open').click();
  await expect(page.getByTestId('open-error')).toHaveText(SERVER_GONE);
  await expect(page.getByText('No saved projects yet.')).toHaveCount(0);
});

test('the Export dialog says so plainly when the server stops during an export, and stops waiting for it', async ({ page, request }) => {
  await page.goto('/');
  await load(page, small(30, 1280, 720));
  await page.getByTestId('btn-export').click();
  const started = page.waitForResponse((r) => r.url().endsWith('/api/export'));
  await page.getByTestId('export-start').click();
  const { id } = (await (await started).json()) as { id: string };
  try {
    await expect(page.getByTestId('export-status')).toContainText(/rendering .*frame \d+/, { timeout: 60_000 });
    let asked = 0;
    await page.route('**/api/jobs/**', (route) => (asked++, route.abort('connectionrefused')));
    await expect(page.getByTestId('export-error')).toHaveText(SERVER_GONE);
    await expect(page.getByTestId('export-status')).toContainText('error');
    const after = asked;
    await page.waitForTimeout(1000); // the dialog polls every 0.3 s while an export runs
    expect(asked).toBe(after);
  } finally {
    await page.unroute('**/api/jobs/**');
    await request.post(`/api/jobs/${id}/cancel`);
  }
});
