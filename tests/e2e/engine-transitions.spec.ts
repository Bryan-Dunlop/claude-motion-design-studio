// A1 scene transitions in real Chromium: the export matches renderFrame inside the transition window for each style,
// the 'lighter' dissolve's endpoints, blend modes inside a fade window, and the "Transition into this scene" UI.
import { expect, test, type Page } from '@playwright/test';
import { ProjectSchema, type Project, type Transition } from '../../src/shared/schema';
import { expectExportMatchesRender, runExport, saveProject } from './exportCompare';
import { browserImport, drag, getState, past } from './helpers';

const base = { visible: true, locked: false, start: 0, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1, keyframes: {} };
const kx = (a: number, b: number, d: number) => ({ x: [{ id: 'k1', time: 0, value: a, easing: { type: 'easeInOut' } }, { id: 'k2', time: d, value: b, easing: { type: 'linear' } }] });
const label = (id: string, content: string, x: number, y: number, duration: number, over: object = {}) => ({
  ...base, id, name: id, type: 'text', duration, x, y, content, fontFamily: 'Inter', fontSize: 64, fontWeight: 800, lineHeight: 1.1, letterSpacing: 0, align: 'center', color: '#ffffff', ...over,
});
const shape = (id: string, x: number, y: number, duration: number, over: object = {}) => ({
  ...base, id, name: id, type: 'shape', duration, x, y, shape: 'rect', width: 260, height: 160, cornerRadius: 16, fill: '#4f7cff', stroke: '#ffffff', strokeWidth: 0, ...over,
});

/** Lay out in 960×540 design units, export at 1920×1080 (4:2:0 chroma loss at sharp colour edges matters less). */
const S = 2;
const SIZED = ['x', 'y', 'width', 'height', 'fontSize', 'cornerRadius', 'strokeWidth', 'blur', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY'];
function at1080<T extends Record<string, unknown>>(layer: T): T {
  const out: Record<string, unknown> = { ...layer };
  for (const k of SIZED) if (typeof out[k] === 'number') out[k] = (out[k] as number) * S;
  const kf = layer.keyframes as Record<string, { value: unknown }[]>;
  out.keyframes = Object.fromEntries(Object.entries(kf).map(([prop, keys]) => [prop, SIZED.includes(prop) ? keys.map((k) => ({ ...k, value: (k.value as number) * S })) : keys]));
  return out as T;
}

/**
 * 1920×1080, 1.5 s. "Base" runs the whole time (lower scene, baked into the backdrop), A runs 0–0.9 s, B starts at
 * 0.6 s with a 0.6 s transition: window [0.6, 1.2) s = frames 18–35. A keeps animating until 0.9 s, then holds.
 */
function transitionProject(type: Transition['type'], direction: Transition['direction'] = 'left'): Project {
  return ProjectSchema.parse({
    schemaVersion: 2,
    settings: { durationSec: 1.5, aspect: '16:9', width: 960 * S, height: 540 * S, fps: 30, background: '#101828' },
    assets: [],
    scenes: [
      { id: 'base', name: 'Base', start: 0, duration: 1.5, layers: [shape('band', 480, 470, 1.5, { width: 960, height: 90, cornerRadius: 0, fill: '#ffcc00' })].map(at1080) },
      { id: 'a', name: 'Hook', start: 0, duration: 0.9, background: '#2d1b40', layers: [
        label('hook', 'Hook', 480, 150, 0.9, { keyframes: kx(300, 660, 0.9) }),
        shape('card', 300, 330, 0.9, { strokeWidth: 10, shadow: true, shadowColor: '#000000aa', shadowBlur: 18, shadowOffsetY: 10, keyframes: kx(250, 420, 0.9) }),
      ].map(at1080) },
      { id: 'b', name: 'Feature', start: 0.6, duration: 0.9, transition: { type, duration: 0.6, direction, easing: { type: 'easeInOut' } }, layers: [
        label('feature', 'Feature', 480, 150, 0.9, { color: '#1b2340', blur: 1 }),
        shape('mul', 640, 400, 0.9, { shape: 'ellipse', width: 300, height: 220, fill: '#ff3366', blendMode: 'multiply', keyframes: kx(700, 560, 0.9) }),
        shape('panel', 260, 330, 0.9, { fill: '#e8ecff', strokeWidth: 6, stroke: '#4f7cff', shadow: true, shadowBlur: 20, shadowOffsetY: 8 }),
      ].map(at1080) },
    ],
  });
}

async function exportAndCompare(page: Page, request: import('@playwright/test').APIRequestContext, p: Project, style: string) {
  const name = `Transition ${style} ${Date.now()}`;
  await saveProject(request, name, p);
  const job = await runExport(request, { project: p, name });
  // Frames inside the window (0.7, 0.9, 1.1 s); the "wrong" frames are outside it.
  return expectExportMatchesRender(page, { project: p, projectName: name, mp4: job.outFile, frames: [21, 27, 33], wrongFrame: (f) => (f < 27 ? 44 : 3) });
}

test('export matches renderFrame inside a cross-fade window', async ({ page, request }) => {
  await exportAndCompare(page, request, transitionProject('fade'), 'fade');
});

test('export matches renderFrame inside a slide window', async ({ page, request }) => {
  await exportAndCompare(page, request, transitionProject('slide', 'up'), 'slide');
});

test('export matches renderFrame inside a wipe window', async ({ page, request }) => {
  await exportAndCompare(page, request, transitionProject('wipe', 'right'), 'wipe');
});

test('export matches renderFrame inside a zoom window', async ({ page, request }) => {
  await exportAndCompare(page, request, transitionProject('zoom'), 'zoom');
});

test('export matches renderFrame inside a blur window', async ({ page, request }) => {
  await exportAndCompare(page, request, transitionProject('blur'), 'blur');
});

test('dissolve endpoints: p → 0 is the outgoing image alone, p → 1 the incoming one alone (within 1/255)', async ({ page }) => {
  const r = await browserImport(page, '/src/shared/transitionDraw.ts', async (mod) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createRenderCanvas } = await load('/src/shared/canvas.ts');
    const W = 96;
    const H = 48;
    // Two opaque images with gradients and text, plus a padded copy of the incoming one.
    const paint = (ctx: CanvasRenderingContext2D, a: string, b: string, word: string, ox = 0) => {
      const g = ctx.createLinearGradient(ox, ox, ox + W, ox + H);
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      ctx.fillStyle = g;
      ctx.fillRect(ox, ox, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 20px sans-serif';
      ctx.fillText(word, ox + 6, ox + 30);
    };
    const O = createRenderCanvas(W, H);
    paint(O.ctx, '#ff3366', '#203040', 'Out');
    const I = createRenderCanvas(W, H);
    paint(I.ctx, '#00ccff', '#ffcc00', 'In');
    const pad = 16;
    const Ipad = createRenderCanvas(W + 2 * pad, H + 2 * pad);
    Ipad.ctx.fillStyle = '#00ff00';
    Ipad.ctx.fillRect(0, 0, W + 2 * pad, H + 2 * pad);
    paint(Ipad.ctx, '#00ccff', '#ffcc00', 'In', pad);
    const pixels = (c: { ctx: CanvasRenderingContext2D }) => c.ctx.getImageData(0, 0, W, H).data;
    const run = (p: number, padded = false) => {
      const t = createRenderCanvas(W, H);
      mod.dissolve(t.ctx, { canvas: O.canvas, pad: 0 }, padded ? { canvas: Ipad.canvas, pad } : { canvas: I.canvas, pad: 0 }, p);
      return pixels(t);
    };
    const maxDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
    const o = pixels(O);
    const i = pixels(I);
    // Mid-point: two identical white images must stay white (no dip).
    const white = createRenderCanvas(W, H);
    white.ctx.fillStyle = '#ffffff';
    white.ctx.fillRect(0, 0, W, H);
    const mid = createRenderCanvas(W, H);
    mod.dissolve(mid.ctx, { canvas: white.canvas, pad: 0 }, { canvas: white.canvas, pad: 0 }, 0.5);
    return {
      p0: maxDiff(run(0), o),
      p0001: maxDiff(run(0.001), o),
      p0999: maxDiff(run(0.999), i),
      p1: maxDiff(run(1), i),
      padded1: maxDiff(run(1, true), i),
      opaqueAtHalf: Math.min(...Array.from(run(0.5).filter((_, k) => k % 4 === 3))),
      whiteAtHalf: Math.min(...Array.from(mid.ctx.getImageData(0, 0, W, H).data as Uint8ClampedArray)),
    };
  });
  expect(r).toEqual({ p0: 0, p0001: expect.any(Number), p0999: expect.any(Number), p1: 0, padded1: 0, opaqueAtHalf: 255, whiteAtHalf: 255 });
  expect(r.p0001).toBeLessThanOrEqual(1);
  expect(r.p0999).toBeLessThanOrEqual(1);
});

test('a blend-mode layer inside a fade window matches the same layer just after the window', async ({ page }) => {
  // B fades in over a two-colour backdrop (lower scene) with a multiply layer. Inside the window (p ≈ 0.998) the
  // multiply must already see the real backdrop, so it matches the first frame after the window.
  const p = ProjectSchema.parse({
    schemaVersion: 2,
    settings: { durationSec: 3, aspect: '16:9', width: 640, height: 360, fps: 30, background: '#ffffff' },
    assets: [],
    scenes: [
      { id: 'base', name: 'Base', start: 0, duration: 3, layers: [shape('left', 160, 180, 3, { width: 320, height: 360, cornerRadius: 0, fill: '#ffcc00' }), shape('right', 480, 180, 3, { width: 320, height: 360, cornerRadius: 0, fill: '#00ccff' })] },
      { id: 'a', name: 'A', start: 0, duration: 1, layers: [label('a', 'A', 320, 60, 1)] },
      { id: 'b', name: 'B', start: 1, duration: 2, transition: { type: 'fade', duration: 0.5, direction: 'left', easing: { type: 'linear' } }, layers: [
        shape('mul', 320, 220, 2, { width: 400, height: 160, cornerRadius: 0, fill: '#ff3366', blendMode: 'multiply' }),
      ] },
    ],
  });
  const r = await browserImport(
    page,
    '/src/shared/renderFrame.ts',
    async (mod, p: Project) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createRenderCanvas, createCanvasPool } = await load('/src/shared/canvas.ts');
      const pool = createCanvasPool();
      const at = (t: number) => {
        const { ctx } = createRenderCanvas(640, 360);
        mod.renderFrame(p, t, ctx, 1, { images: new Map(), canvasPool: pool });
        return ctx.getImageData(120, 140, 400, 160).data; // the multiply layer's area
      };
      const inside = at(1.499);
      const after = at(1.5);
      let max = 0;
      for (let k = 0; k < inside.length; k++) max = Math.max(max, Math.abs(inside[k] - after[k]));
      const px = (d: Uint8ClampedArray, x: number, y: number) => Array.from(d.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 3));
      return { max, afterLeft: px(after, 50, 80), afterRight: px(after, 350, 80) };
    },
    p,
  );
  // After the window: multiply of #ff3366 over #ffcc00 (left) and #00ccff (right).
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
  expect(near(r.afterLeft, [255, 41, 0]), `left ${r.afterLeft}`).toBe(true);
  expect(near(r.afterRight, [0, 41, 102]), `right ${r.afterRight}`).toBe(true);
  // Inside the window (p ≈ 0.998) the same pixels, give or take the 0.2 % still showing the outgoing frame.
  expect(r.max).toBeLessThanOrEqual(2);
});

test('Transition into this scene: style, length, direction, From line, preview, apply to all, strip tooltip, background', async ({ page }) => {
  await page.goto('/');
  const p = ProjectSchema.parse({
    schemaVersion: 2,
    settings: { durationSec: 9, aspect: '16:9', width: 1920, height: 1080, fps: 30, background: '#123456' },
    assets: [],
    scenes: [
      { id: 'hook', name: 'Hook', start: 0, duration: 3, layers: [] },
      { id: 'feature', name: 'Feature', start: 3, duration: 3, layers: [] },
      { id: 'cta', name: 'CTA', start: 6, duration: 3, layers: [] },
    ],
  });
  await page.evaluate((p) => (window as any).__motion.useEditor.getState().loadProject(p, null), p);
  await page.getByTestId('scene-item-1').locator('.name').click();
  const scene = async (id: string) => (await getState(page)).project.scenes.find((s) => s.id === id)!;

  // Cut by default: only the style is shown.
  await expect(page.getByTestId('transition-style')).toHaveValue('none');
  await expect(page.getByTestId('transition-length')).toHaveCount(0);
  await expect(page.getByTestId('transition-style').locator('option')).toHaveText(['None (cut)', 'Cross-fade', 'Slide over', 'Push', 'Wipe', 'Zoom', 'Blur']);

  // Cross-fade: length, easing, From line; no direction.
  let h = await past(page);
  await page.getByTestId('transition-style').selectOption('fade');
  expect(await past(page)).toBe(h + 1);
  expect((await scene('feature')).transition).toMatchObject({ type: 'fade', duration: 0.6 });
  await expect(page.getByTestId('transition-direction')).toHaveCount(0);
  await expect(page.getByTestId('transition-from')).toHaveText('From: Hook');
  await expect(page.getByTestId('transition-strip-Feature')).toHaveAttribute('title', 'Cross-fade from Hook · 0.6 s');
  const lengthRow = page.locator('.row', { has: page.getByTestId('transition-length') });
  await expect(lengthRow).toHaveAttribute('title', 'Plays during the first N s of this scene. The previous scene holds its last frame unless they overlap.');

  // Push: direction with arrow labels; length 0.8; easing.
  await page.getByTestId('transition-style').selectOption('push');
  await expect(page.getByTestId('transition-direction').locator('option')).toHaveText(['← Right to left', '→ Left to right', '↑ Bottom to top', '↓ Top to bottom']);
  await page.getByTestId('transition-direction').selectOption('up');
  await page.getByTestId('transition-length').fill('0.8');
  await page.getByTestId('transition-length').press('Enter');
  await page.getByTestId('transition-easing').selectOption('easeOut');
  expect((await scene('feature')).transition).toEqual({ type: 'push', duration: 0.8, direction: 'up', easing: { type: 'easeOut' } });
  await expect(page.getByTestId('transition-strip-Feature')).toHaveAttribute('title', 'Push from Hook · 0.8 s');

  // ▶ Preview plays from 0.5 s before to 0.5 s after the window, then stops.
  await page.getByTestId('transition-preview').click();
  await expect.poll(() => page.evaluate(() => (window as any).__motion.useEditor.getState().playUntil)).toBeCloseTo(3 + 0.8 + 0.5, 5);
  await expect.poll(() => page.evaluate(() => (window as any).__motion.useEditor.getState().playing), { timeout: 5000 }).toBe(false);
  expect((await getState(page)).time).toBeCloseTo(4.3, 5);

  // Apply to all scenes: every scene except the first, one undo step.
  h = await past(page);
  await page.getByTestId('transition-apply-all').click();
  expect(await past(page)).toBe(h + 1);
  expect((await scene('cta')).transition).toEqual({ type: 'push', duration: 0.8, direction: 'up', easing: { type: 'easeOut' } });
  expect((await scene('hook')).transition.type).toBe('none');
  await expect(page.getByTestId('transition-strip-CTA')).toHaveAttribute('title', 'Push from Feature · 0.8 s');

  // ☐ Own background colour: starts from the project background; one undo step each.
  h = await past(page);
  await page.getByTestId('scene-own-background').check();
  expect(await past(page)).toBe(h + 1);
  expect((await scene('feature')).background).toBe('#123456');
  await expect(page.getByTestId('scene-background')).toHaveValue('#123456');
  await page.getByTestId('scene-own-background').uncheck();
  expect((await scene('feature')).background).toBeNull();

  // The first scene transitions in from the background.
  await page.getByTestId('scene-item-0').locator('.name').click();
  await page.getByTestId('transition-style').selectOption('zoom');
  await expect(page.getByTestId('transition-from')).toHaveText('From: background (no scene before)');
  await expect(page.getByTestId('transition-strip-Hook')).toHaveAttribute('title', 'Zoom from the background · 0.6 s');

  // The strip can be hovered (its tooltip shows) and dragging it still moves the scene, as one undo step.
  const strip = page.getByTestId('transition-strip-CTA');
  await strip.hover({ timeout: 5000 });
  const zoom = await page.evaluate(() => (window as any).__motion.useEditor.getState().zoom as number);
  const b = (await strip.boundingBox())!;
  h = await past(page);
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, zoom, 0);
  expect((await scene('cta')).start).toBeCloseTo(7, 5);
  expect(await past(page)).toBe(h + 1);
});
