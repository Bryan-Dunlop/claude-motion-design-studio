// Project settings → Resolution changes the frame size and scales the whole composition with it, so the picture
// stays the same; typed Width / Height only change the frame.
import { expect, test, type Page } from '@playwright/test';
import { round, setNumber, shortcut, toast } from './app-ui-helpers';
import { getState, layerOf, past } from './helpers';

// A missing control fails fast instead of waiting for the whole test timeout.
test.use({ actionTimeout: 15_000 });

const settings = async (page: Page) => {
  const { width, height, aspect } = (await getState(page)).project.settings;
  return { width, height, aspect };
};
const place = async (page: Page, name: string) => {
  const l = await layerOf(page, name);
  return [round(l.x), round(l.y), round(l.scale)];
};
const rowOf = (page: Page, testId: string) => page.locator('.row').filter({ has: page.getByTestId(testId) });

/** Mean of the preview canvas's red channel once it has drawn the current state. */
const meanRed = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const c = document.querySelector('[data-testid=preview-canvas]') as HTMLCanvasElement;
            const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
            let s = 0;
            for (let i = 0; i < d.length; i += 4) s += d[i];
            resolve(s / (d.length / 4));
          }),
        ),
      ),
  );

test('Resolution preset: every layer is scaled with the frame in one undo step, so the picture stays the same', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-text').click();
  await setNumber(page, 'prop-x', '900');
  await setNumber(page, 'prop-y', '700');
  await page.getByTestId('add-rect').click();
  await setNumber(page, 'prop-x', '2940');
  await shortcut(page, 'Escape');
  await expect(rowOf(page, 'setting-resolution')).toHaveAttribute('title', /Every layer is scaled with the frame/);
  const before = await meanRed(page);
  expect(before).toBeGreaterThan(1);

  const h = await past(page);
  await page.getByTestId('setting-resolution').selectOption('1920');
  expect(await past(page)).toBe(h + 1);
  expect(await settings(page)).toEqual({ width: 1920, height: 1080, aspect: '16:9' });
  // k = 0.5 about the frame centre: x → 960 + 0.5 (x − 1920), y → 540 + 0.5 (y − 1080).
  expect(await place(page, 'Text')).toEqual([450, 350, 0.5]);
  expect(await place(page, 'Rectangle')).toEqual([1470, 540, 0.5]);
  await toast(page, 'Resized to 1920×1080: every layer was scaled with the frame (× 0.5).');
  // Same picture in the preview (it is the same size on screen).
  expect(Math.abs((await meanRed(page)) - before)).toBeLessThan(before * 0.02);

  // The same size again changes nothing.
  await page.getByTestId('setting-resolution').selectOption('1920');
  expect(await past(page)).toBe(h + 1);

  await shortcut(page, 'Control+z');
  expect(await settings(page)).toEqual({ width: 3840, height: 2160, aspect: '16:9' });
  expect(await place(page, 'Text')).toEqual([900, 700, 1]);
});

test('Resolution keeps a vertical frame vertical; typed Width / Height change only the frame and say so', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('setting-aspect').selectOption('9:16'); // 2160×3840
  await page.getByTestId('add-text').click();
  await shortcut(page, 'Escape');
  await page.getByTestId('setting-resolution').selectOption('1280');
  expect(await settings(page)).toEqual({ width: 720, height: 1280, aspect: '9:16' });
  expect(await place(page, 'Text')).toEqual([360, 640, 0.333333]);

  await expect(rowOf(page, 'setting-width')).toHaveAttribute('title', /Layers are not scaled/);
  await expect(rowOf(page, 'setting-height')).toHaveAttribute('title', /Layers are not scaled/);
  await setNumber(page, 'setting-width', '1000');
  expect(await settings(page)).toEqual({ width: 1000, height: 1280, aspect: 'custom' });
  expect(await place(page, 'Text')).toEqual([360, 640, 0.333333]);
});
