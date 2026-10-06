// "+ Scene" makes scenes follow each other (so a transition always has a scene to come from).
import { expect, test } from '@playwright/test';
import { getState, past } from './helpers';

const scenes = async (page: import('@playwright/test').Page) =>
  (await getState(page)).project.scenes.map((s) => ({ name: s.name, start: s.start, end: +(s.start + s.duration).toFixed(6) }));

test('+ Scene splits the last scene (in the middle, or at the playhead) in one undo step', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-scene').click();
  expect(await scenes(page)).toEqual([{ name: 'Scene 1', start: 0, end: 15 }]);

  // Playhead at 0 (not inside the scene): split in the middle.
  const h = await past(page);
  await page.getByTestId('add-scene').click();
  expect(await past(page)).toBe(h + 1);
  expect(await scenes(page)).toEqual([
    { name: 'Scene 1', start: 0, end: 7.5 },
    { name: 'Scene 2', start: 7.5, end: 15 },
  ]);
  await expect(page.locator('.toast')).toContainText('Scene 2 starts at 7.50 s — Scene 1 now ends there.');

  // Playhead inside the last scene: split there.
  await page.evaluate(() => (window as any).__motion.useEditor.getState().setTime(10));
  await page.getByTestId('add-scene').click();
  expect(await scenes(page)).toEqual([
    { name: 'Scene 1', start: 0, end: 7.5 },
    { name: 'Scene 2', start: 7.5, end: 10 },
    { name: 'Scene 3', start: 10, end: 15 },
  ]);

  // A transition on Scene 3 now comes from Scene 2.
  await page.getByTestId('transition-style').selectOption('fade');
  await expect(page.getByTestId('transition-from')).toHaveText('From: Scene 2');

  // Undo restores Scene 2's length.
  await page.keyboard.press('Escape');
  await page.locator('body').press('Control+z'); // transition
  await page.locator('body').press('Control+z'); // scene 3
  expect(await scenes(page)).toEqual([
    { name: 'Scene 1', start: 0, end: 7.5 },
    { name: 'Scene 2', start: 7.5, end: 15 },
  ]);
});
