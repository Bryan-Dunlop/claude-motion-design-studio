// Cursor panel: a click sound can be imported right there (no stray clip on the timeline).
import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './app-audio-helpers';
import { editor, setNumber, shortcut, toast } from './app-ui-helpers';
import { getState, layerOf, past } from './helpers';

// A missing control fails fast instead of waiting for the whole test timeout.
test.use({ actionTimeout: 15_000 });

const tone = (name: string, seconds: number, hz = 1000) => makeWav(test.info().outputPath(name), { expr: `0.5*sin(2*PI*${hz}*t)`, seconds });
const cursor = async (page: Page) => {
  const l = await layerOf(page, 'Cursor');
  if (l.type !== 'cursor') throw new Error('expected a cursor');
  return l;
};

test('Cursor panel → Import sound… makes the file this cursor’s click sound without adding a clip; one undo step', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-cursor').click();
  // With no sound in the project yet, the dropdown points to the button below it.
  await expect(page.getByTestId('cursor-click-sound').locator('option').first()).toHaveText('None (add one below)');
  await expect(page.getByTestId('cursor-import-sound')).toHaveAttribute('title', /not added to the Audio rows/);

  const id = (await cursor(page)).id;
  const h = await past(page);
  await page.getByTestId('cursor-import-sound-input').setInputFiles(tone('click.wav', 0.08));
  await expect.poll(async () => (await cursor(page)).clickSound?.volume).toBe(1);
  let st = await getState(page);
  expect(st.project.assets.map((a) => [a.originalName, a.type])).toEqual([['click.wav', 'audio']]);
  expect((await cursor(page)).clickSound).toEqual({ assetId: st.project.assets[0].id, volume: 1 });
  expect(st.project.audio).toEqual([]); // no clip at the playhead
  await expect(page.getByTestId('audio-row-0')).toHaveCount(0);
  expect(await past(page)).toBe(h + 1);
  await toast(page, 'click.wav is now the click sound of Cursor.');
  // The cursor stays selected and its dropdown shows the new sound.
  expect((await editor(page)).selection.layerIds).toEqual([id]);
  await expect(page.getByTestId('cursor-click-sound')).toHaveValue(st.project.assets[0].id);

  // Another sound replaces it and keeps the volume; the same file again reuses its asset.
  await setNumber(page, 'cursor-click-volume', '80');
  await page.getByTestId('cursor-import-sound-input').setInputFiles(tone('tick.wav', 0.05, 2000));
  await expect.poll(async () => (await getState(page)).project.assets.length).toBe(2);
  st = await getState(page);
  expect((await cursor(page)).clickSound).toEqual({ assetId: st.project.assets[1].id, volume: 0.8 });
  await page.getByTestId('cursor-import-sound-input').setInputFiles(tone('click.wav', 0.08));
  await expect.poll(async () => (await cursor(page)).clickSound?.assetId).toBe(st.project.assets[0].id);
  expect((await getState(page)).project.assets).toHaveLength(2);
  expect((await getState(page)).project.audio).toEqual([]);

  // Undo takes back the reused sound, then the import of tick.wav as one step (sound and asset together).
  await shortcut(page, 'Control+z');
  expect((await cursor(page)).clickSound).toEqual({ assetId: st.project.assets[1].id, volume: 0.8 });
  await shortcut(page, 'Control+z');
  expect((await getState(page)).project.assets.map((a) => a.originalName)).toEqual(['click.wav']);
  expect((await cursor(page)).clickSound).toEqual({ assetId: st.project.assets[0].id, volume: 0.8 });
});

test('Import sound… refuses a file that is not a sound, and changes nothing', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-cursor').click();
  const h = await past(page);
  await page.getByTestId('cursor-import-sound-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  await toast(page, 'logo.png: pick a sound file (MP3, WAV, OGG, M4A, AAC or FLAC) to use as the click sound.');
  expect(await past(page)).toBe(h);
  expect((await getState(page)).project.assets).toEqual([]);
});
