// Typing into the Properties panel: a typed value lands on the item it was typed for, as its own undo step, whatever
// is clicked or pressed next; Escape cancels; Ctrl+S saves it; editor shortcuts still work right after picking a value
// from a dropdown or a colour swatch.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { layersByName, previewMap, setNumber, toast } from './app-ui-helpers';
import { WS } from './exportCompare';
import { drag, getState, past } from './helpers';

const xy = async (page: Page, name: string) => {
  const l = (await layersByName(page))[name] as unknown as { x: number; y: number };
  return [l.x, l.y];
};
const selectedNames = async (page: Page) => {
  const { project } = await getState(page);
  const ids: string[] = await page.evaluate(() => (window as any).__motion.useEditor.getState().selection.layerIds);
  return project.scenes.flatMap((s) => s.layers).filter((l) => ids.includes(l.id)).map((l) => l.name);
};
const clickLayer = (page: Page, name: string) => page.getByTestId(`layer-item-${name}`).locator('.name').click();

/** + Rect at x 800 and + Text at x 3000 (3840×2160 project), as in the review. */
async function rectAndText(page: Page) {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await setNumber(page, 'prop-x', '800');
  await page.getByTestId('add-text').click();
  await setNumber(page, 'prop-x', '3000');
  expect(await xy(page, 'Rectangle')).toEqual([800, 1080]);
  expect(await xy(page, 'Text')).toEqual([3000, 1080]);
}

test('a value typed without Enter goes to the layer it was typed for when another layer is clicked (preview, timeline, list)', async ({ page }) => {
  await rectAndText(page);
  const map = await previewMap(page);

  // Clicking the text in the preview.
  await clickLayer(page, 'Rectangle');
  await page.getByTestId('prop-y').fill('1234');
  let h = await past(page);
  const onText = map.toScreen(3000, 1080);
  await page.mouse.click(onText.x, onText.y);
  expect(await selectedNames(page)).toEqual(['Text']);
  expect(await xy(page, 'Rectangle')).toEqual([800, 1234]);
  expect(await xy(page, 'Text')).toEqual([3000, 1080]);
  expect(await past(page)).toBe(h + 1);

  // Clicking the other layer's label in the timeline.
  await clickLayer(page, 'Rectangle');
  await page.getByTestId('prop-x').fill('111');
  await page.locator('.tl-label', { hasText: 'Text' }).first().dispatchEvent('pointerdown');
  await expect.poll(() => xy(page, 'Rectangle')).toEqual([111, 1234]);
  expect(await xy(page, 'Text')).toEqual([3000, 1080]);

  // A rename, then a click on the other layer in the list.
  await clickLayer(page, 'Text');
  await page.getByTestId('prop-name').fill('Headline');
  await clickLayer(page, 'Rectangle');
  expect(Object.keys(await layersByName(page)).sort()).toEqual(['Headline', 'Rectangle']);

  // The text content is kept too (its section goes away when the rectangle is selected).
  await clickLayer(page, 'Headline');
  await page.getByTestId('prop-content').fill('Big Sale');
  h = await past(page);
  const onRect = map.toScreen(111, 1234);
  await page.mouse.click(onRect.x, onRect.y);
  expect(await selectedNames(page)).toEqual(['Rectangle']);
  expect(((await layersByName(page)).Headline as unknown as { content: string }).content).toBe('Big Sale');
  expect(await past(page)).toBe(h + 1);
});

test('a typed value is its own undo step: a drag that follows is undone separately', async ({ page }) => {
  await rectAndText(page);
  const map = await previewMap(page);
  await clickLayer(page, 'Rectangle');
  await page.getByTestId('prop-opacity').fill('0.5');
  const h = await past(page);
  await drag(page, map.toScreen(800, 1080), 120, 0);
  const moved = (await xy(page, 'Rectangle'))[0];
  expect(moved).toBeGreaterThan(900);
  expect(await past(page)).toBe(h + 2);
  await page.getByTestId('btn-undo').click();
  const r = (await layersByName(page)).Rectangle as unknown as { x: number; opacity: number };
  expect([r.x, r.opacity]).toEqual([800, 0.5]);
});

test('Escape in a number field throws the typed value away', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  const h = await past(page);
  await page.getByTestId('prop-x').fill('999');
  await page.getByTestId('prop-x').press('Escape');
  expect((await xy(page, 'Rectangle'))[0]).toBe(1920);
  expect(await past(page)).toBe(h);
  await expect(page.getByTestId('prop-x')).toHaveValue('1920');
});

test('Ctrl+S while a field still has focus saves the typed value', async ({ page }) => {
  const name = `Typed save ${Date.now()}`;
  await page.goto('/');
  await page.getByTestId('add-text').click();
  await page.keyboard.press('Control+s');
  await page.getByTestId('save-name').fill(name);
  await page.getByTestId('save-confirm').click();
  await toast(page, `Saved ${name}.motion`);

  await page.getByTestId('prop-content').fill('Launch day');
  await page.getByTestId('prop-content').press('Control+s');
  const file = path.join(WS, `${name}.motion`, 'project.json');
  await expect.poll(() => JSON.parse(fs.readFileSync(file, 'utf8')).scenes[0].layers[0].content).toBe('Launch day');
  await page.getByTestId('prop-x').fill('500');
  await page.getByTestId('prop-x').press('Control+s');
  await expect.poll(() => JSON.parse(fs.readFileSync(file, 'utf8')).scenes[0].layers[0].x).toBe(500);
  expect((await getState(page)).dirty).toBe(false);
  await expect(page.getByTestId('dirty-dot')).toHaveCount(0);
});

test('after picking a colour, the next drag is its own undo step', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  const h = await past(page);
  await page.getByTestId('prop-fill').fill('#ff0000');
  expect(await past(page)).toBe(h + 1);
  const map = await previewMap(page);
  await drag(page, map.toScreen(1920, 1080), 120, 0);
  expect(await past(page)).toBe(h + 2);
  await page.getByTestId('btn-undo').click();
  const r = (await layersByName(page)).Rectangle as unknown as { x: number; fill: string };
  expect([r.x, r.fill]).toEqual([1920, '#ff0000']);
});

test('Ctrl+Z, Ctrl+Y and Delete work while a dropdown still has focus after picking from it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  // Picking with the mouse leaves the dropdown focused; selectOption alone doesn't focus it.
  await page.getByTestId('prop-shape').focus();
  await page.getByTestId('prop-shape').selectOption('star');
  await expect(page.getByTestId('prop-shape')).toBeFocused();
  const shape = async () => ((await layersByName(page)).Rectangle as unknown as { shape: string } | undefined)?.shape;
  expect(await shape()).toBe('star');
  await page.keyboard.press('Control+z');
  expect(await shape()).toBe('rect');
  await page.keyboard.press('Control+y');
  expect(await shape()).toBe('star');
  await expect(page.getByTestId('prop-shape')).toBeFocused();
  await page.keyboard.press('Delete');
  expect(await shape()).toBeUndefined();
});
