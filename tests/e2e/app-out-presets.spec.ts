// A fade/slide/scale "Out" preset stays at the end of its layer when the layer gets longer or shorter: the Duration
// field, either edge of its timeline bar, or its scene's end. (It used to stay at the old end: a longer layer faded out
// early and stayed invisible, a shorter one was cut off before its fade.)
import { expect, test, type Page } from '@playwright/test';
import { editor, setNumber } from './app-ui-helpers';
import { drag, getState, layerOf, past } from './helpers';

/** The Rectangle's opacity keyframes as [time, source], with its start and length. */
async function fade(page: Page) {
  const l = await layerOf(page, 'Rectangle');
  return { start: +l.start.toFixed(3), duration: +l.duration.toFixed(3), keys: l.keyframes.opacity.map((k) => [+k.time.toFixed(3), k.source]) };
}
const outAt = (end: number) => [[+(end - 0.6).toFixed(3), 'preset:out'], [end, 'preset:out']];

test('an Out preset follows the layer\'s end: Duration field, bar edges, scene end', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await page.getByTestId('layer-item-Rectangle').locator('.name').click();
  await page.getByText('Animation presets').click();
  await page.getByTestId('preset-kind').selectOption('fade');
  await page.getByTestId('preset-phase').selectOption('out');
  await page.getByTestId('preset-apply').click();
  let f = await fade(page);
  expect(f.keys).toEqual(outAt(f.duration));

  // The Duration field: one undo step.
  const h = await past(page);
  await setNumber(page, 'prop-duration', '8');
  await expect.poll(async () => (await fade(page)).keys).toEqual(outAt(8));
  expect(await past(page)).toBe(h + 1);
  await setNumber(page, 'prop-duration', '6');
  await expect.poll(async () => (await fade(page)).keys).toEqual(outAt(6));

  // The bar's right edge: 2 s longer. (Grabbed near its top: the fade's last keyframe sits on the middle of the edge.)
  const zoom = (await editor(page)).zoom;
  let bar = (await page.getByTestId('layer-bar-Rectangle').boundingBox())!;
  await drag(page, { x: bar.x + bar.width - 2, y: bar.y + 2 }, 2 * zoom, 0);
  f = await fade(page);
  expect(f.duration).toBeCloseTo(8, 1);
  expect(f.keys).toEqual(outAt(f.duration));

  // The bar's left edge: 1 s later start, same end, so the fade stays where it was in the video.
  const endBefore = f.start + f.duration;
  bar = (await page.getByTestId('layer-bar-Rectangle').boundingBox())!;
  await drag(page, { x: bar.x + 2, y: bar.y + bar.height / 2 }, zoom, 0);
  f = await fade(page);
  expect(f.start).toBeGreaterThan(0.5);
  expect(f.start + f.duration).toBeCloseTo(endBefore, 3);
  expect(f.keys).toEqual(outAt(f.duration));

  // The scene's end, pulled back past the layer's end: the layer ends with the scene, and so does its fade.
  const scene = (await page.getByTestId('scene-block-Scene 1').boundingBox())!;
  const sceneEnd = (await getState(page)).project.scenes[0].duration;
  await drag(page, { x: scene.x + scene.width - 2, y: scene.y + scene.height / 2 }, -(sceneEnd - 5) * zoom, 0);
  f = await fade(page);
  expect(f.start + f.duration).toBeCloseTo(5, 1);
  expect(f.keys).toEqual(outAt(f.duration));
});
