// B2 snapping and selection in the preview and the timeline: moves snap to the exact frame centre / edges / other
// layers / the safe box (magenta guides, Ctrl or the Snap toggle to move freely), the Guides overlay per format,
// marquee selection, line hit-testing, and timeline drags snapping to the playhead, bars, scene edges and clicks.
import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './app-audio-helpers';
import { center, drag, getState, past } from './helpers';
import { editor, layersByName, previewMap, setNumber, setTime, startDragAt, track } from './app-ui-helpers';

const rounded = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });
const layer = async (page: Page, name: string) => (await layersByName(page))[name] as { x: number; y: number; start: number; duration: number; id: string };
const guide = (page: Page, axis: 'x' | 'y') => page.locator(`[data-testid=snap-guide][data-axis=${axis}]`);

test('preview move: the selection centre snaps to the exact frame centre with magenta guides; Ctrl or Snap off moves freely', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('btn-snap')).toHaveAttribute('aria-pressed', 'true'); // on by default
  await expect(page.getByTestId('btn-snap')).toHaveAttribute('title', 'Snap to edges, centre and other layers (hold Ctrl/⌘ to drag freely)');
  await page.getByTestId('add-rect').click();
  const { k, toScreen } = await previewMap(page);

  // Holding Ctrl: free move, no snapping.
  await drag(page, rounded(toScreen(1920, 1080)), 60, 40, 'Control');
  let r = await layer(page, 'Rectangle');
  expect(r.x).toBeCloseTo(1920 + 60 * k, 1);
  expect(r.y).toBeCloseTo(1080 + 40 * k, 1);

  // Back to within a few pixels of the centre: it lands exactly on it, and the guides show while dragging.
  let h = await past(page);
  const release = await startDragAt(page, rounded(toScreen(r.x, r.y)), -60 + 3, -40 + 2);
  await expect(guide(page, 'x')).toHaveAttribute('data-pos', '1920');
  await expect(guide(page, 'y')).toHaveAttribute('data-pos', '1080');
  await release();
  await expect(page.getByTestId('snap-guide')).toHaveCount(0);
  r = await layer(page, 'Rectangle');
  expect([r.x, r.y]).toEqual([1920, 1080]);
  expect(await past(page)).toBe(h + 1);

  // Ctrl: a small move stays where it is dropped.
  await drag(page, rounded(toScreen(1920, 1080)), 3, 0, 'Control');
  r = await layer(page, 'Rectangle');
  expect(r.x).toBeCloseTo(1920 + 3 * k, 1);

  // Snap toggle off: no snapping without Ctrl either; the choice is remembered.
  await page.getByTestId('btn-snap').click();
  await expect(page.getByTestId('btn-snap')).toHaveAttribute('aria-pressed', 'false');
  await drag(page, rounded(toScreen(r.x, 1080)), -2, 0);
  r = await layer(page, 'Rectangle');
  expect(r.x).toBeCloseTo(1920 + k, 1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('motion-studio.prefs')!).snap)).toBe(false);
  await page.reload();
  await expect(page.getByTestId('btn-snap')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('btn-snap').click();
  await expect(page.getByTestId('btn-snap')).toHaveAttribute('aria-pressed', 'true');
});

test('preview move snaps edges to other layers and to the frame edges', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click(); // 648 × 648 at the centre: 1596 … 2244
  await page.getByTestId('add-shape-menu').click();
  await page.getByTestId('add-shape-ellipse').click();
  const { k, toScreen } = await previewMap(page);
  await drag(page, rounded(toScreen(1920, 1080)), 300, 0, 'Control');
  let e = await layer(page, 'Ellipse');
  // Bring the ellipse's left edge to within ~2 screen px of the rectangle's right edge (2244).
  const dx = Math.round((2244 - (e.x - 324)) / k) + 2;
  const release = await startDragAt(page, rounded(toScreen(e.x, 1080)), dx, 0);
  await expect(guide(page, 'x')).toHaveAttribute('data-pos', '2244');
  await release();
  e = await layer(page, 'Ellipse');
  expect(e.x).toBe(2244 + 324);

  // The rectangle's left edge onto the frame's left edge.
  await page.getByTestId('layer-item-Rectangle').locator('.name').click();
  await drag(page, rounded(toScreen(1920, 1080)), Math.round(-1596 / k) + 2, 0);
  expect((await layer(page, 'Rectangle')).x).toBe(324);
});

test('Guides: centre lines, thirds and a 90% title-safe box, or the Reels/TikTok UI box for 9:16; moves snap to the box', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('guides-overlay')).toHaveCount(0);
  await page.getByTestId('btn-guides').click();
  await expect(page.getByTestId('btn-guides')).toHaveAttribute('aria-pressed', 'true');
  const box = page.getByTestId('safe-box');
  await expect(box).toHaveAttribute('data-kind', 'title');
  const attrs = () => box.evaluate((el) => ['x', 'y', 'width', 'height'].map((a) => Number(el.getAttribute(a))));
  expect(await attrs()).toEqual([192, 108, 3456, 1944]);
  await expect(page.getByTestId('safe-label')).toHaveText(/Title safe/);
  await expect(page.locator('.guide-centre')).toHaveCount(2);
  await expect(page.locator('.guide-third')).toHaveCount(4);
  // An overlay only: the canvas itself has just the background where the box line is.
  const px = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=preview-canvas]') as HTMLCanvasElement;
    return [...c.getContext('2d')!.getImageData(Math.round((192 / 3840) * c.width), Math.round(c.height / 2), 1, 1).data];
  });
  expect(px.slice(0, 3)).toEqual([0, 0, 0]);

  // 9:16: the area Reels/TikTok leave free (6% sides, 14% top, 35% bottom).
  await page.getByTestId('setting-aspect').selectOption('9:16');
  await expect(box).toHaveAttribute('data-kind', 'reels');
  const [x, y, w, hh] = await attrs();
  expect(x).toBeCloseTo(0.06 * 2160, 6);
  expect(y).toBeCloseTo(0.14 * 3840, 6);
  expect(w).toBeCloseTo(0.88 * 2160, 6);
  expect(hh).toBeCloseTo(0.51 * 3840, 6);
  await expect(page.getByTestId('safe-label')).toHaveText(/Reels\/TikTok UI/);

  // With guides on, a move snaps to the box edge too: the 648-wide rect's left edge onto x = 129.6.
  await page.getByTestId('add-rect').click();
  const m = await previewMap(page);
  const dx = Math.round((129.6 - (1080 - 324)) / m.k) + 1;
  await drag(page, { x: Math.round(m.toScreen(1080, 1920).x), y: Math.round(m.toScreen(1080, 1920).y) }, dx, 0);
  expect((await layer(page, 'Rectangle')).x).toBeCloseTo(129.6 + 324, 6);

  // Remembered; off hides it.
  await page.reload();
  await expect(page.getByTestId('btn-guides')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('btn-guides').click();
  await expect(page.getByTestId('guides-overlay')).toHaveCount(0);
});

test('marquee on empty space selects the layers it touches (Shift adds, locked layers are skipped); lines are hit near their stroke', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await setNumber(page, 'prop-x', '800'); // 476 … 1124 × 756 … 1404
  await page.getByTestId('add-shape-menu').click();
  await page.getByTestId('add-shape-ellipse').click();
  await setNumber(page, 'prop-x', '3000'); // 2676 … 3324
  const { toScreen } = await previewMap(page);
  const ids = async () => (await editor(page)).selection.layerIds;
  const L = await layersByName(page);

  // Drag from an empty corner over the rectangle only.
  let release = await startDragAt(page, rounded(toScreen(40, 40)), Math.round(toScreen(1000, 900).x - toScreen(40, 40).x), Math.round(toScreen(1000, 900).y - toScreen(40, 40).y));
  await expect(page.getByTestId('marquee')).toBeVisible();
  expect(await ids()).toEqual([L.Rectangle.id]); // live while dragging
  await release();
  await expect(page.getByTestId('marquee')).toHaveCount(0);
  expect(await ids()).toEqual([L.Rectangle.id]);

  // Shift + marquee over the ellipse adds it.
  release = await startDragAt(page, rounded(toScreen(3700, 100)), Math.round(toScreen(3100, 1000).x - toScreen(3700, 100).x), Math.round(toScreen(3100, 1000).y - toScreen(3700, 100).y), 'Shift');
  await release();
  expect(await ids()).toEqual([L.Rectangle.id, L.Ellipse.id]);

  // A click on empty space clears; a marquee touching nothing selects nothing.
  await page.mouse.click(Math.round(toScreen(1900, 300).x), Math.round(toScreen(1900, 300).y));
  expect(await ids()).toEqual([]);

  // Locked layers are left out.
  await page.getByTestId('layer-item-Ellipse').locator('button[title^="Lock layer"]').click();
  release = await startDragAt(page, rounded(toScreen(30, 30)), Math.round(toScreen(3810, 2130).x - toScreen(30, 30).x), Math.round(toScreen(3810, 2130).y - toScreen(30, 30).y));
  await release();
  expect(await ids()).toEqual([L.Rectangle.id]);

  // A line is hit within max(stroke/2, 6 screen px) of its segment, not anywhere in its box.
  await page.getByTestId('add-shape-menu').click();
  await page.getByTestId('add-shape-line').click();
  const line = (await layersByName(page)).Line;
  expect(line).toMatchObject({ x: 1920, y: 1080, height: 86, strokeWidth: 17 });
  const m = await previewMap(page);
  await page.keyboard.press('Escape');
  await page.mouse.click(Math.round(m.toScreen(1920, 1080).x), Math.round(m.toScreen(1920, 1080).y) - 9); // ~38 px above: inside the box, off the line
  expect(await ids()).toEqual([]);
  await page.mouse.click(Math.round(m.toScreen(1920, 1080).x), Math.round(m.toScreen(1920, 1080).y) - 4); // ~17 px above
  expect(await ids()).toEqual([line.id]);
});

test('timeline: keyframes and layer bars snap to the playhead (magenta line); Ctrl or Snap off moves in whole frames', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await page.getByTestId('kf-toggle-x').click(); // a key at 0 s
  await setTime(page, 2);
  const zoom = (await editor(page)).zoom;

  // The key, dragged to a few pixels short of the playhead (where it was before the click moved it), lands on it.
  const release = await startDragAt(page, await center(page, 'kf-Rectangle-0'), 2 * zoom - 5, 0);
  await expect(page.getByTestId('tl-snap-line')).toBeVisible();
  expect(await page.getByTestId('tl-snap-line').evaluate((el) => (el as HTMLElement).style.left)).toBe(`${170 + 2 * zoom}px`);
  await release();
  await expect(page.getByTestId('tl-snap-line')).toHaveCount(0);
  expect(await track(page, 'Rectangle', 'x')).toEqual([[2, 1920]]);

  // The bar's start, 5 px past the playhead at 3 s, snaps back onto it.
  await setTime(page, 3);
  const barAt = async () => {
    const b = (await page.getByTestId('layer-bar-Rectangle').boundingBox())!;
    return { x: Math.round(b.x + 400), y: Math.round(b.y + b.height / 2) };
  };
  await drag(page, await barAt(), 3 * zoom + 5, 0);
  expect((await layer(page, 'Rectangle')).start).toBeCloseTo(3, 9);
  // Holding Ctrl: whole frames only (4 px = 2 frames at 30 fps).
  await drag(page, await barAt(), 4, 0, 'Control');
  expect((await layer(page, 'Rectangle')).start).toBeCloseTo(3 + 2 / 30, 9);
  // Snap off: 8 px back is 4 frames, even though the playhead is 4 px away.
  await page.getByTestId('btn-snap').click();
  await drag(page, await barAt(), -8, 0);
  expect((await layer(page, 'Rectangle')).start).toBeCloseTo(3 - 2 / 30, 9);
  await page.getByTestId('btn-snap').click();
});

test('timeline: a scene edge snaps to a layer bar end, a sound clip to a cursor click', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-cursor').click(); // clicks at 1.4 s
  await setNumber(page, 'prop-duration', '10');
  const zoom = (await editor(page)).zoom;

  // Scene 1 ends at 15 s; drag its end to ~10.1 s: it snaps to the cursor bar's end (10 s).
  const sb = (await page.getByTestId('scene-block-Scene 1').boundingBox())!;
  await drag(page, { x: Math.round(sb.x + sb.width - 2), y: Math.round(sb.y + sb.height / 2) }, -5 * zoom + 6, 0);
  expect((await getState(page)).project.scenes[0].duration).toBeCloseTo(10, 9);

  // A short sound at 0 s, dragged to just before the click at 1.4 s, starts exactly on the click.
  await page.getByTestId('file-input').setInputFiles(makeWav(test.info().outputPath('tick.wav'), { expr: '0.5*sin(2*PI*880*t)', seconds: 0.3 }));
  await expect(page.getByTestId('audio-clip-0')).toBeVisible();
  expect((await getState(page)).project.audio[0].start).toBe(0);
  const cb = (await page.getByTestId('audio-clip-0').boundingBox())!;
  await drag(page, { x: Math.round(cb.x + cb.width / 2), y: Math.round(cb.y + cb.height / 2) }, Math.round(1.4 * zoom) - 5, 0);
  expect((await getState(page)).project.audio[0].start).toBe(1.4);
});
