// B2 layout: toolbar menus (shared component: close on outside pointerdown / Escape / picking an item), the File ▾
// menu, the draggable timeline splitter (remembered, clamped) and the Scenes row that stays under the ruler.
import { expect, test } from '@playwright/test';
import { makeWav } from './app-audio-helpers';
import { drag, getState } from './helpers';
import { editor, store } from './app-ui-helpers';

test('menus close on an outside click and on Escape (which then leaves the selection alone); one open at a time', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  const shapes = page.getByTestId('add-shape-menu-list');

  await page.getByTestId('add-shape-menu').click();
  await expect(shapes).toBeVisible();
  await expect(page.getByTestId('add-shape-menu')).toHaveAttribute('aria-expanded', 'true');
  // A pointerdown anywhere else closes it.
  await page.locator('.panel-head h3').first().click();
  await expect(shapes).toHaveCount(0);

  // Escape closes it, and is used up by the menu: the rectangle stays selected.
  await page.getByTestId('add-shape-menu').click();
  await expect(shapes).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(shapes).toHaveCount(0);
  expect((await editor(page)).selection.layerIds).toHaveLength(1);
  await page.keyboard.press('Escape'); // no menu open: Escape clears the selection as usual
  expect((await editor(page)).selection.layerIds).toHaveLength(0);

  // Picking an item runs it and closes the menu.
  await page.getByTestId('add-shape-menu').click();
  await page.getByTestId('add-shape-star').click();
  await expect(shapes).toHaveCount(0);
  expect((await getState(page)).project.scenes[0].layers.map((l) => l.name)).toEqual(['Rectangle', 'Star']);

  // Clicking the button again closes it; opening another menu closes the first.
  await page.getByTestId('add-shape-menu').click();
  await page.getByTestId('add-shape-menu').click();
  await expect(shapes).toHaveCount(0);
  await page.getByTestId('add-shape-menu').click();
  await page.getByTestId('file-menu').click();
  await expect(shapes).toHaveCount(0);
  await expect(page.getByTestId('file-menu-list')).toBeVisible();
  await expect(page.getByTestId('file-export-zip')).toHaveText('Export .zip');
  await expect(page.getByTestId('file-import-zip')).toHaveText('Import .zip');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('file-menu-list')).toHaveCount(0);

  // More ▾ lists what isn't available, disabled.
  await page.getByTestId('more-menu').click();
  await expect(page.getByTestId('more-menu-list').getByRole('menuitem')).toHaveText(['Video clips — Not available', 'AI generation — Not available', 'Cloud sync — Not available']);
  for (const item of await page.getByTestId('more-menu-list').getByRole('menuitem').all()) await expect(item).toBeDisabled();
  await page.mouse.click(700, 400); // the preview
  await expect(page.getByTestId('more-menu-list')).toHaveCount(0);
});

test('the timeline splitter resizes the timeline (160 px … 60% of the window) and is remembered; the Scenes row stays under the ruler', async ({ page }) => {
  await page.goto('/');
  const timeline = page.locator('.timeline');
  const height = async () => Math.round((await timeline.boundingBox())!.height);
  expect(await height()).toBe(240);
  const splitter = async () => {
    const b = (await page.getByTestId('timeline-splitter').boundingBox())!;
    return { x: Math.round(b.x + 300), y: Math.round(b.y + b.height / 2) };
  };
  await expect(page.getByTestId('timeline-splitter')).toHaveAttribute('title', 'Drag to make the timeline taller or shorter');

  // Up 100 px → 100 px taller; the preview gives the room.
  const preview = (await page.getByTestId('preview-canvas').boundingBox())!.height;
  await drag(page, await splitter(), 0, -100);
  expect(await height()).toBe(340);
  expect((await page.getByTestId('preview-canvas').boundingBox())!.height).toBeLessThan(preview);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('motion-studio.prefs')!).timelineHeight)).toBe(340);
  // Clamped: never below 160 px or above 60% of the window (950 px → 570 px).
  await drag(page, await splitter(), 0, 400);
  expect(await height()).toBe(160);
  await drag(page, await splitter(), 0, -900);
  expect(await height()).toBe(570);
  // Toasts sit above the timeline.
  await store(page, "s.toast('hello')");
  await expect(page.locator('.toasts')).toHaveCSS('bottom', '580px');
  await page.reload();
  expect(await height()).toBe(570);
  await drag(page, await splitter(), 0, 300);
  expect(await height()).toBe(270);

  // Many layers: scrolling the timeline keeps the ruler and the Scenes row in view.
  await page.getByTestId('add-rect').click();
  await store(page, `s.commit((d) => { const l = d.scenes[0].layers[0]; for (let i = 0; i < 24; i++) d.scenes[0].layers.push({ ...JSON.parse(JSON.stringify(l)), id: 'extra' + i, name: 'Extra ' + i }); })`);
  const scroll = page.locator('.timeline-scroll');
  await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(150);
  const top = (await scroll.boundingBox())!.y;
  const ruler = (await page.locator('.tl-row.ruler').boundingBox())!;
  const scenes = (await page.getByTestId('scenes-row').boundingBox())!;
  expect(Math.round(ruler.y)).toBe(Math.round(top));
  expect(Math.round(scenes.y)).toBe(Math.round(ruler.y + ruler.height));
  // …and still works: dragging the scene block there still moves the scene.
  await expect(page.getByTestId('scene-block-Scene 1')).toBeVisible();
});

test('a focused checkbox keeps Space (toggles it) but Delete still deletes the selection', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(makeWav(test.info().outputPath('beep.wav'), { expr: '0.5*sin(2*PI*440*t)', seconds: 1 }));
  await expect(page.getByTestId('audio-row-0')).toBeVisible();
  const mute = page.getByTestId('clip-mute');
  await mute.click();
  await expect(mute).toBeFocused();
  expect((await getState(page)).project.audio[0].muted).toBe(true);
  await page.keyboard.press(' ');
  expect((await getState(page)).project.audio[0].muted).toBe(false);
  expect(await page.evaluate(() => (window as any).__motion.useEditor.getState().playing)).toBe(false);
  await page.keyboard.press('Delete');
  expect((await getState(page)).project.audio).toEqual([]);
});
