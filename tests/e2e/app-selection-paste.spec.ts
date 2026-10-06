// Selection and clipboard details: a scene click deselects an audio clip, a dropped keyframe replaces the one it lands
// on, and layers pasted into another project bring their files along.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { emptyProject } from '../../src/shared/schema';
import { makeWav } from './app-audio-helpers';
import { editor, layersByName, previewMap, setNumber, setTime, shortcut, store, toast, track } from './app-ui-helpers';
import { WS } from './exportCompare';
import { center, drag, getState, past } from './helpers';

const audioSelection = async (page: Page) => (await editor(page)).selection.audioIds;

test('selecting a scene (list or timeline) or clicking empty preview space deselects an audio clip', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-text').click();
  await page.getByTestId('add-scene').click();
  await page.getByTestId('file-input').setInputFiles(makeWav(test.info().outputPath('tone.wav'), { expr: '0.5*sin(2*PI*440*t)', seconds: 2 }));
  await expect.poll(() => audioSelection(page)).toHaveLength(1);
  const clipId = (await audioSelection(page))[0];

  // The scenes list: the scene's own settings show, and Delete no longer removes the clip.
  await page.getByTestId('scene-item-0').click();
  expect(await audioSelection(page)).toEqual([]);
  await expect(page.getByTestId('transition-section')).toBeVisible();
  await shortcut(page, 'Delete');
  expect((await getState(page)).project.audio).toHaveLength(1);

  // A scene block in the timeline.
  await store(page, `s.select({ audioIds: ['${clipId}'] })`);
  await page.getByTestId('scene-block-Scene 2').dispatchEvent('pointerdown');
  expect(await audioSelection(page)).toEqual([]);

  // Empty space in the preview (no layer in the top-left corner).
  await store(page, `s.select({ audioIds: ['${clipId}'] })`);
  const map = await previewMap(page);
  const empty = map.toScreen(80, 80);
  await page.mouse.click(empty.x, empty.y);
  expect(await audioSelection(page)).toEqual([]);
});

test('a keyframe dropped onto another keyframe of the same property replaces it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await page.getByTestId('kf-toggle-x').click();
  await setTime(page, 2);
  await setNumber(page, 'prop-x', '2400');
  await setTime(page, 4);
  await setNumber(page, 'prop-x', '2900');
  expect(await track(page, 'Rectangle', 'x')).toEqual([[0, 1920], [2, 2400], [4, 2900]]);

  await page.getByTestId('tl-expand-Rectangle').click();
  const zoom = (await editor(page)).zoom;
  const h = await past(page);
  await drag(page, await center(page, 'kf-Rectangle-x-120'), -2 * zoom, 0);
  expect(await track(page, 'Rectangle', 'x')).toEqual([[0, 1920], [2, 2900]]);
  expect(await past(page)).toBe(h + 1);

  // Typing at that frame now edits the one key there.
  await setTime(page, 2);
  await setNumber(page, 'prop-x', '1000');
  expect(await track(page, 'Rectangle', 'x')).toEqual([[0, 1920], [2, 1000]]);
});

test('layers pasted into another project keep an image that only exists in the source project folder', async ({ page }) => {
  // A PNG this workspace has never stored (the fixture plus unique bytes after its end, which decoders ignore), in a
  // project folder only, as a .zip import leaves it.
  const name = `Logo source ${Date.now()}`;
  const png = Buffer.concat([fs.readFileSync('tests/fixtures/fixture.png'), Buffer.from(name)]);
  const hash = crypto.createHash('sha256').update(png).digest('hex');
  const rel = `assets/${hash.slice(0, 8)}-logo.png`;
  const dir = path.join(WS, `${name}.motion`);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), png);
  const source = emptyProject();
  source.assets = [{ id: 'asset_logo', originalName: 'logo.png', relativePath: rel, type: 'image', hash, width: 64, height: 64 }];
  source.scenes = [{
    id: 'scene_a', name: 'Scene 1', start: 0, duration: 5, background: null, transition: { type: 'none', duration: 0.5, direction: 'left', easing: { type: 'easeInOut' } },
    layers: [{
      id: 'layer_logo', name: 'logo', type: 'image', assetId: 'asset_logo', width: 320, height: 320, visible: true, locked: false, start: 0, duration: 5,
      anchorX: 0.5, anchorY: 0.5, x: 960, y: 540, scale: 1, rotation: 0, opacity: 1, keyframes: {},
    }],
  }] as never;
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(source));

  await page.goto('/');
  await page.getByTestId('btn-open').click();
  await page.getByTestId(`open-${name}`).click();
  await expect.poll(async () => (await getState(page)).name).toBe(name);
  await expect.poll(async () => (await getState(page)).missing).toEqual([]);
  await page.getByTestId('layer-item-logo').locator('.name').click();
  await shortcut(page, 'Control+c');
  await toast(page, 'Copied 1 layer');

  // A new, unsaved project.
  await page.evaluate((p) => (window as any).__motion.useEditor.getState().loadProject(p, null), emptyProject());
  await shortcut(page, 'Control+v');
  await expect.poll(async () => Object.keys(await layersByName(page))).toEqual(['logo']);
  await expect.poll(async () => (await getState(page)).missing).toEqual([]);

  const target = `Pasted ${Date.now()}`;
  await shortcut(page, 'Control+s');
  await page.getByTestId('save-name').fill(target);
  await page.getByTestId('save-confirm').click();
  await toast(page, `Saved ${target}.motion`);
  expect(fs.readFileSync(path.join(WS, `${target}.motion`, rel)).equals(png)).toBe(true);
});
