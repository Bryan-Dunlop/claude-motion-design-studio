// Scene structure edits keep the timeline coherent: a scene that gets shorter takes its layers' ends along (so exit
// animations still play before the cut), a duplicated scene goes after the last one, and the Scenes list ↑/↓ change
// when scenes play.
import { expect, test, type Page } from '@playwright/test';
import { editor, round, setNumber, setTime, shortcut, startDragAt, toast } from './app-ui-helpers';
import { getState, layerOf, past } from './helpers';

// A missing control fails fast instead of waiting for the whole test timeout.
test.use({ actionTimeout: 15_000 });

const scenes = async (page: Page) => (await getState(page)).project.scenes.map((s) => [s.name, round(s.start), round(s.duration)]);
const timing = async (page: Page, name: string) => {
  const l = await layerOf(page, name);
  return [round(l.start), round(l.duration)];
};

/** Mean red of the preview canvas at time t, once the preview has drawn that time (white text on black). */
async function meanRed(page: Page, t: number) {
  await setTime(page, t);
  return page.evaluate(
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
}

/** Centre of a scene block's right (end) edge in the timeline. */
async function sceneEndEdge(page: Page, name: string) {
  const b = (await page.getByTestId(`scene-block-${name}`).locator('.edge.right').boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test.describe('a scene that gets shorter takes its layers along (R7)', () => {
  test('+ Scene: the split scene’s layers end at the cut, so “Animate out” plays before it; keyframes stay; one undo step', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-text').click();
    // A keyframe late in the layer: the split never deletes or moves keyframes.
    await setTime(page, 14);
    await page.getByTestId('kf-toggle-opacity').click();
    await setTime(page, 0);
    await page.getByTestId('textanim-section').locator('summary').first().click();
    await page.getByTestId('textanim-out-style').selectOption({ label: 'Words fade out' });
    const shown = await meanRed(page, 3);
    expect(shown).toBeGreaterThan(0.3);

    // Playhead at 0, not inside the scene's splittable part: it is split in the middle.
    await setTime(page, 0);
    const h = await past(page);
    await shortcut(page, 'Escape');
    await page.getByTestId('add-scene').click();
    expect(await past(page)).toBe(h + 1);
    expect(await scenes(page)).toEqual([
      ['Scene 1', 0, 7.5],
      ['Scene 2', 7.5, 7.5],
    ]);
    expect(await timing(page, 'Text')).toEqual([0, 7.5]);
    expect((await layerOf(page, 'Text')).keyframes.opacity.map((k) => round(k.time))).toEqual([14]);
    await toast(page, 'Scene 2 starts at 7.50 s — Scene 1 now ends there. 1 of its layers now ends there too');

    // The words fade out during the last 0.34 s of Scene 1 instead of being cut off at 7.5 s.
    expect(await meanRed(page, 3)).toBeCloseTo(shown, 3);
    expect(await meanRed(page, 7.45)).toBeLessThan(shown * 0.5);

    // ▶ Preview of "Animate out" now plays the end of Scene 1 (from 0.5 s before the words start leaving to 0.5 s
    // after the cut), not the end of the video where Scene 2 shows.
    await page.getByTestId('scene-item-0').locator('.name').click();
    await page.getByTestId('layer-item-Text').locator('.name').click();
    await page.getByTestId('textanim-out-preview').click();
    await expect.poll(async () => round((await editor(page)).time)).toBe(8);

    await shortcut(page, 'Control+z');
    expect(await scenes(page)).toEqual([['Scene 1', 0, 15]]);
    expect(await timing(page, 'Text')).toEqual([0, 15]);
  });

  test('Duration in the scene’s properties: layers that would run past the new end end there; layers that ended at the end follow it when it gets longer', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-text').click(); // 0–15
    await page.getByTestId('add-rect').click();
    await setNumber(page, 'prop-duration', '4'); // the rectangle ends before the scene does
    await page.getByTestId('scene-item-0').locator('.name').click();

    let h = await past(page);
    await setNumber(page, 'scene-duration', '10');
    expect(await past(page)).toBe(h + 1);
    expect(await scenes(page)).toEqual([['Scene 1', 0, 10]]);
    expect(await timing(page, 'Text')).toEqual([0, 10]);
    expect(await timing(page, 'Rectangle')).toEqual([0, 4]);

    // Longer: the text (which ended at the scene end) follows it; the rectangle keeps its length.
    h = await past(page);
    await setNumber(page, 'scene-duration', '12');
    expect(await past(page)).toBe(h + 1);
    expect(await timing(page, 'Text')).toEqual([0, 12]);
    expect(await timing(page, 'Rectangle')).toEqual([0, 4]);

    // Shorter than the rectangle too: both end at the new end.
    await setNumber(page, 'scene-duration', '3');
    expect(await timing(page, 'Text')).toEqual([0, 3]);
    expect(await timing(page, 'Rectangle')).toEqual([0, 3]);

    // One undo step each.
    await shortcut(page, 'Control+z');
    expect(await scenes(page)).toEqual([['Scene 1', 0, 12]]);
    expect(await timing(page, 'Text')).toEqual([0, 12]);
    expect(await timing(page, 'Rectangle')).toEqual([0, 4]);
  });

  test('trimming a scene’s end in the timeline: layers follow live, back and forth, as one undo step', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-text').click(); // 0–15
    await page.getByTestId('add-rect').click();
    await setNumber(page, 'prop-duration', '4');
    await page.getByTestId('scene-item-0').locator('.name').click();
    const zoom = (await editor(page)).zoom;
    const h = await past(page);

    // Ctrl: whole-frame steps without snapping, so the times below are exact.
    const release = await startDragAt(page, await sceneEndEdge(page, 'Scene 1'), -12 * zoom, 0, 'Control');
    expect(await scenes(page)).toEqual([['Scene 1', 0, 3]]);
    expect(await timing(page, 'Text')).toEqual([0, 3]);
    expect(await timing(page, 'Rectangle')).toEqual([0, 3]);
    // Still dragging, back to the right: the layers come back from where the drag started.
    const at = await sceneEndEdge(page, 'Scene 1');
    await page.mouse.move(at.x + 3 * zoom, at.y);
    await page.mouse.move(at.x + 7 * zoom, at.y);
    expect(await scenes(page)).toEqual([['Scene 1', 0, 10]]);
    expect(await timing(page, 'Text')).toEqual([0, 10]);
    expect(await timing(page, 'Rectangle')).toEqual([0, 4]);
    await release();
    expect(await past(page)).toBe(h + 1);

    await shortcut(page, 'Control+z');
    expect(await scenes(page)).toEqual([['Scene 1', 0, 15]]);
    expect(await timing(page, 'Text')).toEqual([0, 15]);
    expect(await timing(page, 'Rectangle')).toEqual([0, 4]);
  });
});

const videoLength = async (page: Page) => (await getState(page)).project.settings.durationSec;

test.describe('duplicate scene (R8)', () => {
  test('⧉ on a scene that fills the video: the copy goes after it, the video gets longer, the playhead follows; one undo step', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-text').click();
    const zoom = (await editor(page)).zoom;
    const h = await past(page);
    await page.getByTestId('scene-duplicate-0').click();
    expect(await past(page)).toBe(h + 1);
    expect(await scenes(page)).toEqual([
      ['Scene 1', 0, 15],
      ['Scene 1 copy', 15, 15],
    ]);
    expect(await videoLength(page)).toBe(30);
    await toast(page, 'Scene 1 copy starts at 15.00 s — the video is now 30 s.');
    expect((await editor(page)).time).toBe(15);
    const st = await getState(page);
    expect((await editor(page)).selection.sceneId).toBe(st.project.scenes[1].id);
    // Its own layers (new ids), same scene-relative timing.
    const [src, copy] = st.project.scenes.map((s) => s.layers[0]);
    expect(copy).toMatchObject({ name: 'Text', start: src.start, duration: src.duration });
    expect(copy.id).not.toBe(src.id);
    // Both blocks are visible side by side in the timeline.
    const b1 = (await page.getByTestId('scene-block-Scene 1').boundingBox())!;
    const b2 = (await page.getByTestId('scene-block-Scene 1 copy').boundingBox())!;
    expect(b2.x - b1.x).toBeCloseTo(15 * zoom, 0);

    await shortcut(page, 'Control+z');
    expect(await scenes(page)).toEqual([['Scene 1', 0, 15]]);
    expect(await videoLength(page)).toBe(15);
  });

  test('a copy of an earlier scene also goes after the last one; with room left at the end the video keeps its length', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-text').click();
    await page.getByTestId('add-scene').click(); // Scene 1 0–7.5, Scene 2 7.5–15
    await page.getByTestId('scene-duplicate-0').click();
    expect(await scenes(page)).toEqual([
      ['Scene 1', 0, 7.5],
      ['Scene 2', 7.5, 7.5],
      ['Scene 1 copy', 15, 7.5],
    ]);
    expect(await videoLength(page)).toBe(22.5);
    await toast(page, 'Scene 1 copy starts at 15.00 s — the video is now 22.5 s.');

    // 40 s of video: the copy of Scene 2 fits after the last scene.
    await setNumber(page, 'setting-duration', '40');
    await page.getByTestId('scene-duplicate-1').click();
    expect(await scenes(page)).toEqual([
      ['Scene 1', 0, 7.5],
      ['Scene 2', 7.5, 7.5],
      ['Scene 1 copy', 15, 7.5],
      ['Scene 2 copy', 22.5, 7.5],
    ]);
    expect(await videoLength(page)).toBe(40);
    await toast(page, 'Scene 2 copy starts at 22.50 s.');
    expect((await editor(page)).time).toBe(22.5);
  });
});
