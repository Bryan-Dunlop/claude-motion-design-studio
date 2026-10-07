// Covers the remaining Phase 1/2 editor features: handles, panels, timeline bars, playback, imports, easing.
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { center, drag, getState, layerOf, past } from './helpers';

test('preview handles: scale, rotate (Shift snaps 15°), Shift-constrained move; each drag is one undo step', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  let h = await past(page);

  // Scale from the bottom-right corner outward.
  await drag(page, await center(page, 'handle-scale-2'), 60, 60);
  const scaled = await layerOf(page, 'Rectangle');
  expect(scaled.scale).toBeGreaterThan(1.2);
  expect(await past(page)).toBe(h + 1);
  h++;

  // Rotate with Shift: snaps to a multiple of 15°.
  await drag(page, await center(page, 'handle-rotate'), 120, 60, 'Shift');
  const rotated = await layerOf(page, 'Rectangle');
  expect(rotated.rotation).not.toBe(0);
  expect(Math.abs(rotated.rotation % 15)).toBeLessThan(1e-9);
  expect(await past(page)).toBe(h + 1);
  h++;

  // Shift-move mostly horizontally: y must not change.
  const before = await layerOf(page, 'Rectangle');
  const canvas = (await page.getByTestId('preview-canvas').boundingBox())!;
  await drag(page, { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }, 120, 25, 'Shift');
  const moved = await layerOf(page, 'Rectangle');
  expect(moved.x).toBeGreaterThan(before.x + 100);
  expect(moved.y).toBe(before.y);
  expect(await past(page)).toBe(h + 1);

  // Selection is synced: the layer is selected in the list and the timeline.
  await expect(page.getByTestId('layer-item-Rectangle')).toHaveClass(/sel/);
  await expect(page.getByTestId('layer-bar-Rectangle')).toHaveClass(/sel/);

  // Click empty space deselects everywhere.
  await page.mouse.click(canvas.x + 5, canvas.y + 5);
  await expect(page.getByTestId('layer-item-Rectangle')).not.toHaveClass(/sel/);
});

test('scenes and layers panels: create, duplicate, rename, reorder, hide, lock, delete', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-scene').click();
  await page.getByTestId('add-scene').click();
  let st = await getState(page);
  expect(st.project.scenes.map((s) => s.name)).toEqual(['Scene 1', 'Scene 2']);

  // Rename scene 1 by double-click.
  await page.getByTestId('scene-item-0').locator('.name').dblclick();
  await page.locator('.rename').fill('Intro');
  await page.locator('.rename').press('Enter');
  // Duplicate (the copy goes after the last scene), reorder down, delete.
  await page.getByTestId('scene-item-0').locator('button[title^="Duplicate scene"]').click();
  st = await getState(page);
  expect(st.project.scenes.map((s) => s.name)).toEqual(['Intro', 'Scene 2', 'Intro copy']);
  await page.getByTestId('scene-item-0').locator('button[title^="Move scene down"]').click();
  st = await getState(page);
  expect(st.project.scenes.map((s) => s.name)).toEqual(['Scene 2', 'Intro', 'Intro copy']);
  await page.getByTestId('scene-item-2').locator('button[title^="Delete scene"]').click();
  st = await getState(page);
  expect(st.project.scenes.map((s) => s.name)).toEqual(['Scene 2', 'Intro']);

  // Layers in the selected scene.
  await page.getByTestId('scene-item-1').locator('.name').click();
  await page.getByTestId('add-text').click();
  await page.getByTestId('add-rect').click();
  const scene = () => getState(page).then((s) => s.project.scenes[1]);
  expect((await scene()).layers.map((l) => l.name)).toEqual(['Text', 'Rectangle']);
  await page.getByTestId('layer-item-Rectangle').locator('button[title^="Send backward"]').click();
  expect((await scene()).layers.map((l) => l.name)).toEqual(['Rectangle', 'Text']);
  await page.getByTestId('layer-item-Text').locator('button[title="Hide layer"]').click();
  expect((await scene()).layers.find((l) => l.name === 'Text')!.visible).toBe(false);
  await page.getByTestId('layer-item-Text').locator('button[title^="Lock layer"]').click();
  expect((await scene()).layers.find((l) => l.name === 'Text')!.locked).toBe(true);
  await page.getByTestId('layer-item-Rectangle').locator('.name').dblclick();
  await page.locator('.rename').fill('Box');
  await page.locator('.rename').press('Enter');
  await page.getByTestId('layer-item-Box').locator('button[title="Duplicate layer"]').click();
  expect((await scene()).layers.map((l) => l.name)).toEqual(['Box', 'Box copy', 'Text']);
  await page.getByTestId('layer-item-Box copy').locator('button[title="Delete layer"]').click();
  expect((await scene()).layers.map((l) => l.name)).toEqual(['Box', 'Text']);
  // Undo brings it back.
  await page.locator('body').press('Control+z');
  expect((await scene()).layers.map((l) => l.name)).toEqual(['Box', 'Box copy', 'Text']);
});

test('timeline: drag scene boundary, move and trim layer bars, zoom', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  const zoom = await page.evaluate(() => (window as any).__motion.useEditor.getState().zoom as number);

  // Trim scene end by -5s via its right edge: the layer, which ran to the scene end, now ends there too.
  const sb = (await page.getByTestId('scene-block-Scene 1').boundingBox())!;
  await drag(page, { x: sb.x + sb.width - 2, y: sb.y + sb.height / 2 }, -5 * zoom, 0);
  expect((await getState(page)).project.scenes[0].duration).toBeCloseTo(10, 5);
  expect((await layerOf(page, 'Rectangle')).duration).toBeCloseTo(10, 5);

  // Move the layer bar +2s.
  const lb = (await page.getByTestId('layer-bar-Rectangle').boundingBox())!;
  await drag(page, { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 }, 2 * zoom, 0);
  let l = await layerOf(page, 'Rectangle');
  expect(l.start).toBeCloseTo(2, 5);
  // Trim its end by -3s.
  const lb2 = (await page.getByTestId('layer-bar-Rectangle').boundingBox())!;
  await drag(page, { x: lb2.x + lb2.width - 2, y: lb2.y + lb2.height / 2 }, -3 * zoom, 0);
  l = await layerOf(page, 'Rectangle');
  expect(l.duration).toBeCloseTo(7, 5);

  // Zoom with the slider changes pixels-per-second.
  await page.locator('.tl-footer input[type=range]').fill('200');
  expect(await page.evaluate(() => (window as any).__motion.useEditor.getState().zoom)).toBe(200);
});

test('playback: Space plays and pauses, arrows step frames, loop wraps, counters update', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-text').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('setting-duration').fill('1');
  await page.getByTestId('setting-duration').press('Enter');
  await page.locator('body').click({ position: { x: 700, y: 400 } });

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('frame-counter')).toHaveText('frame 2 / 29');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('frame-counter')).toHaveText('frame 1 / 29');

  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  const t = (await getState(page)).time;
  expect(t).toBeGreaterThan(0.1);
  await page.waitForTimeout(200);
  expect((await getState(page)).time).toBe(t); // paused

  // Without loop, playback stops at the end.
  await page.keyboard.press('Space');
  await expect.poll(async () => (await getState(page)).time, { timeout: 3000 }).toBe(1);
  expect(await page.evaluate(() => (window as any).__motion.useEditor.getState().playing)).toBe(false);

  // With loop, it wraps and keeps playing.
  await page.getByRole('button', { name: '⟳ Loop' }).click();
  await page.getByTestId('btn-play').click();
  await page.waitForTimeout(1300);
  const st = await page.evaluate(() => ({ ...(window as any).__motion.useEditor.getState() }));
  expect(st.playing).toBe(true);
  expect(st.time).toBeLessThan(1);
  await expect(page.getByTestId('timecode')).toContainText('/ 00:01.00');
});

test('imports SVG and fonts byte-for-byte; font becomes selectable; spring easing on a keyframe', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles([path.resolve('tests/fixtures/shape.svg'), path.resolve('tests/fixtures/TestFont.woff2')]);
  await expect(page.getByTestId('layer-item-shape')).toBeVisible();
  // The files are imported one after another: wait for the font too before reading the asset list.
  await expect.poll(async () => (await getState(page)).project.assets.length).toBe(2);
  let st = await getState(page);
  expect(st.project.assets.map((a) => [a.type, a.originalName])).toEqual([
    ['svg', 'shape.svg'],
    ['font', 'TestFont.woff2'],
  ]);
  await expect.poll(async () => (await getState(page)).missing).toEqual([]);

  await page.getByTestId('add-text').click();
  await page.getByTestId('prop-fontFamily').selectOption('TestFont');
  expect((await layerOf(page, 'Text')).type === 'text' && (await layerOf(page, 'Text') as any).fontFamily).toBe('TestFont');

  // Keyframe + spring easing via the easing picker.
  await page.getByTestId('kf-toggle-opacity').click();
  await page.getByTestId('kf-easing').selectOption('spring');
  await expect(page.getByTestId('easing-curve').first()).toBeVisible();
  await page.getByTestId('spring-damping').fill('5');
  await page.getByTestId('spring-damping').press('Enter');
  st = await getState(page);
  const text = st.project.scenes[0].layers.find((l) => l.name === 'Text')!;
  expect(text.keyframes.opacity[0].easing).toEqual({ type: 'spring', stiffness: 170, damping: 5, mass: 1 });
});

test('cursor layer: drag a path point in the preview, add a click at the playhead', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-cursor').click();
  const before = (await layerOf(page, 'Cursor')) as any;
  await drag(page, await center(page, 'cursor-point-1'), -80, 60);
  const after = (await layerOf(page, 'Cursor')) as any;
  expect(after.points[1].x).toBeLessThan(before.points[1].x - 50);
  expect(after.points[1].y).toBeGreaterThan(before.points[1].y + 50);
  expect(after.points[0]).toEqual(before.points[0]);
  await page.getByRole('button', { name: '+ Click at playhead' }).click();
  expect(((await layerOf(page, 'Cursor')) as any).clicks).toHaveLength(2);
  await page.getByTestId('cursor-smoothing').fill('0');
  await page.getByTestId('cursor-smoothing').press('Enter');
  expect(((await layerOf(page, 'Cursor')) as any).smoothing).toBe(0);
});
