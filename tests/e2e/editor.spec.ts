// Spec flow: new project -> import fixture image -> place it -> keyframes on x and opacity ->
// move second keyframe in time -> scrub to midpoint + screenshot -> undo (value reverts) -> redo ->
// save -> reload app -> open project -> deep-compare project.json and confirm assets load.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { comparable, getState } from './helpers';

const FIXTURE = path.resolve('tests/fixtures/fixture.png');
const WS = path.resolve('.e2e-workspace');

test('full editing flow round-trips through save/open', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  // 1. New, empty project on first launch.
  await expect(page).toHaveTitle(/Untitled/);
  let st = await getState(page);
  expect(st.project.scenes).toHaveLength(0);
  expect(st.project.settings).toMatchObject({ durationSec: 15, aspect: '16:9', width: 3840, height: 2160, fps: 30 });

  // 2. Import the fixture image.
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('layer-item-fixture')).toBeVisible();
  st = await getState(page);
  const img = st.project.scenes[0].layers[0];
  expect(img.type).toBe('image');
  expect(st.project.assets[0]).toMatchObject({ originalName: 'fixture.png', type: 'image', width: 320, height: 240 });

  // 3. Place it: drag in the preview (move gesture) to the left.
  const canvas = page.getByTestId('preview-canvas');
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 100, cy, { steps: 8 });
  await page.mouse.move(cx - 200, cy, { steps: 8 });
  await page.mouse.up();
  st = await getState(page);
  const placedX = (st.project.scenes[0].layers[0] as { x: number }).x;
  expect(placedX).toBeLessThan(1920 - 500);
  const historyAfterPlace = await page.evaluate(() => (window as any).__motion.useEditor.getState().past.length);

  // 4. Keyframes on x and opacity at t=0, then at t=2s change values (creates second keyframes).
  await page.getByTestId('kf-toggle-x').click();
  await page.getByTestId('kf-toggle-opacity').click();
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.getByTestId('layer-item-fixture').locator('.name').click();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
  expect((await getState(page)).time).toBeCloseTo(2, 5);
  await page.getByTestId('prop-x').fill(String(placedX + 1200));
  await page.getByTestId('prop-x').press('Enter');
  await page.getByTestId('prop-opacity').fill('0.2');
  await page.getByTestId('prop-opacity').press('Enter');
  st = await getState(page);
  let layer = st.project.scenes[0].layers[0];
  expect(layer.keyframes.x.map((k) => [k.time, k.value])).toEqual([[0, placedX], [2, placedX + 1200]]);
  expect(layer.keyframes.opacity.map((k) => [k.time, k.value])).toEqual([[0, 1], [2, 0.2]]);

  // 5. Move the second keyframe (frame 60) to 3s by dragging its diamond +1s on the timeline.
  const zoom = await page.evaluate(() => (window as any).__motion.useEditor.getState().zoom as number);
  const diamond = page.getByTestId('kf-fixture-60');
  const db = (await diamond.boundingBox())!;
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
  await page.mouse.down();
  await page.mouse.move(db.x + db.width / 2 + zoom / 2, db.y + db.height / 2, { steps: 5 });
  await page.mouse.move(db.x + db.width / 2 + zoom, db.y + db.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('kf-fixture-90')).toBeVisible();
  layer = (await getState(page)).project.scenes[0].layers[0];
  expect(layer.keyframes.x.map((k) => k.time)).toEqual([0, 3]);
  expect(layer.keyframes.opacity.map((k) => k.time)).toEqual([0, 3]);
  const historyAfterKeyDrag = await page.evaluate(() => (window as any).__motion.useEditor.getState().past.length);
  // 2 toggles + 2 value edits + 1 drag = 5 steps; the whole drag is ONE step.
  expect(historyAfterKeyDrag - historyAfterPlace).toBe(5);

  // 6. Scrub to the midpoint (1.5s) via the ruler and screenshot the preview.
  const ruler = page.getByTestId('timeline-ruler');
  const rb = (await ruler.boundingBox())!;
  await page.mouse.click(rb.x + 1.5 * zoom, rb.y + rb.height / 2);
  expect((await getState(page)).time).toBeCloseTo(1.5, 5);
  const fieldValue = (id: string) => page.getByTestId(id).inputValue().then(Number);
  // easeInOut is symmetric -> exactly halfway. (Poll: the field re-renders a frame after the scrub.)
  await expect.poll(() => fieldValue('prop-x')).toBeCloseTo(placedX + 600, 0);
  await expect.poll(() => fieldValue('prop-opacity')).toBeCloseTo(0.6, 2);
  const midX = await fieldValue('prop-x');
  await canvas.screenshot({ path: test.info().outputPath('midpoint.png') });

  // 7. Undo: keyframe goes back to 2s, so the value at 1.5s reverts.
  await page.locator('body').press('Control+z');
  layer = (await getState(page)).project.scenes[0].layers[0];
  expect(layer.keyframes.x.map((k) => k.time)).toEqual([0, 2]);
  // At 1.5s with the second key back at 2s the value is 3/4 of the way (easeInOut(0.75)), so it reverts upward.
  await expect.poll(() => fieldValue('prop-x')).toBeGreaterThan(midX + 100);

  // 8. Redo.
  await page.locator('body').press('Control+Shift+z');
  layer = (await getState(page)).project.scenes[0].layers[0];
  expect(layer.keyframes.x.map((k) => k.time)).toEqual([0, 3]);
  await expect.poll(() => fieldValue('prop-x')).toBeCloseTo(midX, 1);

  // 9. Save.
  const name = `E2E ${Date.now()}`;
  await expect(page.getByTestId('dirty-dot')).toBeVisible();
  await page.getByTestId('btn-save').click();
  await page.getByTestId('save-name').fill(name);
  await page.getByTestId('save-confirm').click();
  await expect(page.getByTestId('dirty-dot')).toHaveCount(0);
  await expect(page).toHaveTitle(new RegExp(`^${name}`));
  const before = (await getState(page)).project;
  const dir = path.join(WS, `${name}.motion`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  expect(comparable(onDisk)).toEqual(comparable(before));
  // Original asset copied byte-for-byte.
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const assetFile = path.join(dir, before.assets[0].relativePath);
  expect(sha(fs.readFileSync(assetFile))).toBe(sha(fs.readFileSync(FIXTURE)));
  expect(before.assets[0].hash).toBe(sha(fs.readFileSync(FIXTURE)));

  // 10. Reload the app, open the project.
  await page.reload();
  await expect(page).toHaveTitle(/Untitled/);
  await page.getByTestId('btn-open').click();
  await page.getByTestId(`open-${name}`).click();
  await expect(page).toHaveTitle(new RegExp(`^${name}`));

  // 11. Deep-compare and confirm assets load.
  const after = await getState(page);
  expect(comparable(after.project)).toEqual(comparable(before));
  expect(comparable(after.project)).toEqual(comparable(onDisk));
  await expect.poll(async () => (await getState(page)).missing).toEqual([]);
  await expect(page.getByText('Relink')).toHaveCount(0);
  // The image is actually drawn: sample the preview at the layer centre at t=0 (opacity 1).
  const px = await page.evaluate(({ x, y }) => {
    const c = document.querySelector('[data-testid=preview-canvas]') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(Math.round((x / 3840) * c.width), Math.round((y / 2160) * c.height), 1, 1).data;
    return [...d];
  }, { x: placedX, y: 1080 });
  expect(px[0] + px[1] + px[2]).toBeGreaterThan(30); // not the black background
  expect(errors).toEqual([]);
});

test('missing asset shows a placeholder and can be relinked', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('layer-item-fixture')).toBeVisible();
  const name = `Missing ${Date.now()}`;
  await page.getByTestId('btn-save').click();
  await page.getByTestId('save-name').fill(name);
  await page.getByTestId('save-confirm').click();
  await expect(page.getByTestId('dirty-dot')).toHaveCount(0);
  const st = await getState(page);
  const dir = path.join(WS, `${name}.motion`);
  // Delete the asset from both the project folder and the scratch store.
  fs.rmSync(path.join(dir, st.project.assets[0].relativePath));
  for (const f of fs.readdirSync(path.join(WS, '.scratch'))) if (f.startsWith(st.project.assets[0].hash)) fs.rmSync(path.join(WS, '.scratch', f));
  await page.reload();
  await page.getByTestId('btn-open').click();
  await page.getByTestId(`open-${name}`).click();
  await expect(page.getByText(/Missing: fixture.png/).first()).toBeVisible();
  await page.locator('label:has-text("Relink") input[type=file]').first().setInputFiles(FIXTURE);
  await expect.poll(async () => (await getState(page)).missing).toEqual([]);
  await expect(page.getByText(/Missing: fixture.png/)).toHaveCount(0);
});

test('project settings changes never delete layers; presets and stagger generate editable data', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-text').click();
  await page.getByTestId('add-rect').click();
  await page.getByTestId('add-cursor').click();
  let st = await getState(page);
  expect(st.project.scenes[0].layers).toHaveLength(3);

  // Preset on the rectangle.
  await page.getByTestId('layer-item-Rectangle').locator('.name').click();
  await page.getByText('Animation presets').click();
  await page.getByTestId('preset-kind').selectOption('slide');
  await page.getByTestId('preset-apply').click();
  st = await getState(page);
  const rect = st.project.scenes[0].layers.find((l) => l.name === 'Rectangle')!;
  expect(Object.keys(rect.keyframes).sort()).toEqual(['opacity', 'y']);
  // Re-applying replaces rather than duplicates.
  await page.getByTestId('preset-apply').click();
  st = await getState(page);
  expect(st.project.scenes[0].layers.find((l) => l.name === 'Rectangle')!.keyframes.y).toHaveLength(2);

  // Stagger all three.
  await page.getByTestId('layer-item-Cursor').locator('.name').click();
  await page.getByTestId('layer-item-Rectangle').locator('.name').click({ modifiers: ['Shift'] });
  await page.getByTestId('layer-item-Text').locator('.name').click({ modifiers: ['Shift'] });
  await page.getByTestId('stagger-interval').fill('0.5');
  await page.getByTestId('stagger-interval').press('Enter');
  await page.getByTestId('stagger-apply').click();
  st = await getState(page);
  const starts = Object.fromEntries(st.project.scenes[0].layers.map((l) => [l.name, l.start]));
  expect(starts).toEqual({ Cursor: 0, Rectangle: 0.5, Text: 1 });

  // Settings: aspect / size / duration changes keep all layers.
  await page.keyboard.press('Escape');
  await page.getByTestId('setting-aspect').selectOption('9:16');
  await page.getByTestId('setting-duration').fill('3');
  await page.getByTestId('setting-duration').press('Enter');
  await page.getByTestId('setting-fps').selectOption('60');
  st = await getState(page);
  expect(st.project.settings).toMatchObject({ aspect: '9:16', width: 2160, height: 3840, durationSec: 3, fps: 60 });
  expect(st.project.scenes[0].layers).toHaveLength(3);
  // Undo the three settings changes one step at a time.
  for (let i = 0; i < 3; i++) await page.locator('body').press('Control+z');
  st = await getState(page);
  expect(st.project.settings).toMatchObject({ aspect: '16:9', width: 3840, height: 2160, durationSec: 15, fps: 30 });
});
