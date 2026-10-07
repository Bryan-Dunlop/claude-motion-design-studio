// The editor preview: it shows the frame the counter, the PNG still and the MP4 show, and one frame that cannot be
// drawn never takes the editor down.
import { expect, test, type Page } from '@playwright/test';
import { makeProject } from '../../src/shared/factories';
import type { Project } from '../../src/shared/schema';

const L = { visible: true, locked: false, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1, keyframes: {} };
const rect = { ...L, id: 'r', name: 'Red', type: 'shape', shape: 'rect', start: 0, duration: 1, x: 480, y: 270, width: 960, height: 540, cornerRadius: 0, fill: '#ff0000', stroke: '#000000', strokeWidth: 0 };

function project(layers: object[]): Project {
  return makeProject({
    schemaVersion: 2,
    settings: { durationSec: 1, aspect: 'custom', width: 960, height: 540, fps: 30, background: '#ffffff' },
    assets: [],
    scenes: [{ id: 's', name: 'S', start: 0, duration: 1, layers: layers as never }],
  } as never);
}

const load = (page: Page, p: Project) => page.evaluate((p) => (window as any).__motion.useEditor.getState().loadProject(p, null), p);
const setTime = (page: Page, t: number) => page.evaluate((t) => (window as any).__motion.useEditor.getState().setTime(t), t);
/** RGB in the middle of the preview canvas. */
const centre = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview-canvas"]') as HTMLCanvasElement;
    return Array.from(c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data.slice(0, 3));
  });

test('with the playhead at the very end (where playback stops), the preview shows the last frame', async ({ page }) => {
  await page.goto('/');
  await load(page, project([rect]));
  await setTime(page, 0.5);
  await expect.poll(() => centre(page)).toEqual([255, 0, 0]);
  // t = durationSec is past the last frame (29 at 0.967 s); no scene is active there, but frame 29 shows the rect.
  await setTime(page, 1);
  await expect(page.getByTestId('frame-counter')).toContainText('29');
  await expect.poll(() => centre(page)).toEqual([255, 0, 0]);
});

test('a frame that cannot be drawn shows a message in the preview, and the editor keeps working', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  // Stand-in for any bug that makes renderFrame throw: drawing the text 'Oops' fails while that layer shows.
  await page.evaluate(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text: string, ...rest: [number, number]) {
      if (text === 'Oops') throw new Error('test: this layer cannot be drawn');
      return fillText.call(this, text, ...rest);
    };
  });
  const bad = { ...L, id: 'b', name: 'Bad', type: 'text', start: 0, duration: 0.5, x: 480, y: 270, content: 'Oops', fontFamily: 'Inter', fontSize: 72, fontWeight: 700,
    lineHeight: 1.2, letterSpacing: 0, align: 'center', color: '#000000' };
  await load(page, project([rect, bad]));
  await setTime(page, 0.25);
  await expect(page.getByTestId('frame-error')).toContainText('could not be drawn: test: this layer cannot be drawn');
  await expect(page.getByTestId('layer-item-Bad')).toBeVisible();
  // Past the bad layer the frame draws again.
  await setTime(page, 0.75);
  await expect(page.getByTestId('frame-error')).toHaveCount(0);
  await expect.poll(() => centre(page)).toEqual([255, 0, 0]);
  expect(errors).toEqual([]);
});
