// Determinism in the real browser: rendering the same t gives identical pixels, even when other frames
// (different times / features) are rendered in between — catches state leaking through scratch or pooled canvases.
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { makeProject } from '../../src/shared/factories';
import type { Project } from '../../src/shared/schema';
import { sampleProject } from '../fixtures/sampleProject';
import { browserImport, openRenderPage } from './helpers';

const L = { visible: true, locked: false, start: 0, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1, keyframes: {} };
const oneScene = (settings: object, layers: object[]): Project =>
  makeProject({
    schemaVersion: 2,
    settings: { durationSec: 1, aspect: 'custom', width: 960, height: 540, fps: 30, background: '#ffffff', ...settings },
    assets: [],
    scenes: [{ id: 's', name: 'S', start: 0, duration: 1, layers: layers as never }],
  } as never);
const textLayer = (over: object) => ({ ...L, id: 't', name: 'T', type: 'text', duration: 1, x: 480, y: 270, content: 'Hello', fontFamily: 'Inter', fontSize: 72, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center', color: '#1a1a1a', ...over });

test('the bundled Inter font is really loaded on the render page', async ({ page }) => {
  await openRenderPage(page);
  // Web fonts load lazily: request them, then check they really loaded (fails if the dev server refuses to serve
  // the @fontsource files, e.g. node_modules symlinked from outside the project root).
  const loaded = await page.evaluate(async () => {
    const faces = [...(await document.fonts.load('700 32px Inter')), ...(await document.fonts.load('800 32px Inter'))];
    return { faces: faces.length, ok700: document.fonts.check('700 32px Inter'), ok800: document.fonts.check('800 32px Inter') };
  });
  expect(loaded.faces).toBeGreaterThan(0);
  expect(loaded.ok700).toBe(true);
  expect(loaded.ok800).toBe(true);
});

test('renderFrame is pixel-deterministic in Chromium, also when frames are interleaved', async ({ page }) => {
  await openRenderPage(page);
  const project = sampleProject();
  const times = [0, 0.5, 1.0, 1.73, 6];
  const first = await page.evaluate(async ({ p, times }) => {
    const m = (window as any).motion;
    const out: string[] = [];
    for (const t of times) out.push((await m.render(p, t)).sha256);
    return out;
  }, { p: project, times });
  // Render the same times again in reverse order, with other frames in between.
  const second = await page.evaluate(async ({ p, times }) => {
    const m = (window as any).motion;
    const out: Record<number, string> = {};
    for (const t of [...times].reverse()) {
      await m.render(p, t + 0.123);
      out[t] = (await m.render(p, t)).sha256;
    }
    return times.map((t: number) => out[t]);
  }, { p: project, times });
  expect(second).toEqual(first);
  // Different times produce different pixels (sanity: the animation actually moves).
  expect(new Set(first).size).toBeGreaterThan(2);
});

test('browserImport gives pixel-level tests a real canvas', async ({ page }) => {
  const px = await browserImport(page, '/src/shared/canvas.ts', (mod) => {
    const { ctx } = mod.createRenderCanvas(4, 4);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 4, 4);
    return Array.from(ctx.getImageData(1, 1, 1, 1).data);
  });
  expect(px).toEqual([255, 0, 0, 255]);
});

test('canvas pool: canvases are distinct within a frame and fully reset when reused', async ({ page }) => {
  const r = await browserImport(page, '/src/shared/canvas.ts', (mod) => {
    const pool = mod.createCanvasPool();
    const a = pool.acquire(8, 8);
    const b = pool.acquire(8, 8);
    const distinct = a.canvas !== b.canvas;
    a.ctx.translate(3, 3);
    a.ctx.globalAlpha = 0.2;
    a.ctx.filter = 'blur(2px)';
    a.ctx.fillStyle = '#ff0000';
    a.ctx.fillRect(0, 0, 8, 8);
    pool.releaseAll();
    const c = pool.acquire(8, 8);
    const reused = c.canvas === a.canvas || c.canvas === b.canvas;
    const t = c.ctx.getTransform();
    const pixel = Array.from(c.ctx.getImageData(0, 0, 1, 1).data);
    return { distinct, reused, identity: t.a === 1 && t.e === 0 && t.f === 0, alpha: c.ctx.globalAlpha, filter: c.ctx.filter, pixel };
  });
  expect(r).toEqual({ distinct: true, reused: true, identity: true, alpha: 1, filter: 'none', pixel: [0, 0, 0, 0] });
});

test('a see-through background does not leave trails: a frame drawn over another one equals a fresh frame', async ({ page }) => {
  const rect = { ...L, id: 'r', name: 'R', type: 'shape', shape: 'rect', duration: 1, x: 100, y: 270, width: 120, height: 120, cornerRadius: 0, fill: '#000000', stroke: '#000000', strokeWidth: 0,
    keyframes: { x: [{ id: 'k1', time: 0, value: 100, easing: { type: 'linear' } }, { id: 'k2', time: 1, value: 860, easing: { type: 'linear' } }] } };
  const p = oneScene({ background: '#ffffff80' }, [rect]);
  const r = await browserImport(page, '/src/shared/renderFrame.ts', async (mod, p: Project) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createRenderCanvas } = await load('/src/shared/canvas.ts');
    const reused = createRenderCanvas(960, 540).ctx;
    for (const t of [0, 0.2, 0.4]) mod.renderFrame(p, t, reused, 1);
    mod.renderFrame(p, 20 / 30, reused, 1);
    const fresh = createRenderCanvas(960, 540).ctx;
    mod.renderFrame(p, 20 / 30, fresh, 1);
    const a = reused.getImageData(0, 0, 960, 540).data;
    const b = fresh.getImageData(0, 0, 960, 540).data;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    // Half-white over black, opaque.
    return { diff, px: Array.from(b.slice(0, 4) as Uint8ClampedArray) };
  }, p);
  expect(r.diff).toBe(0);
  expect(r.px[3]).toBe(255);
  expect(Math.abs(r.px[0] - 128)).toBeLessThanOrEqual(1);
});

test('text outside Latin-1 (Polish, Cyrillic, Vietnamese) is in Inter from the very first frame', async ({ page }) => {
  // Inter is split into one file per script; the first frame used to draw these letters in a fallback font while the
  // missing parts were still loading, so every video started with a visible font jump.
  for (const content of ['Łódź → Привет', 'Zażółć gęślą jaźń', 'Tiếng Việt']) {
    await page.goto('/render.html');
    await expect(page).toHaveTitle('render-ready');
    const p = oneScene({}, [textLayer({ content })]);
    const first = await page.evaluate(async (p) => (await (window as any).motion.render(p, 0)).sha256, p);
    await page.waitForTimeout(1500);
    const later = await page.evaluate(async (p) => (await (window as any).motion.render(p, 0)).sha256, p);
    expect(first, content).toBe(later);
  }
});

test('an imported font whose name starts with a digit or is a reserved word draws at its real size', async ({ page }) => {
  const bytes = Array.from(fs.readFileSync('tests/fixtures/TestFont.woff2'));
  const widths = await browserImport(page, '/src/shared/renderFrame.ts', async (mod, bytes: number[]) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createRenderCanvas } = await load('/src/shared/canvas.ts');
    const out: Record<string, number> = {};
    for (const family of ['Dee3', '3Dee', '04B_03__', 'Default']) {
      const face = new FontFace(family, new Uint8Array(bytes).buffer);
      await face.load();
      document.fonts.add(face);
      const { ctx } = createRenderCanvas(800, 200);
      ctx.font = mod.fontString({ fontWeight: 400, fontSize: 100, fontFamily: family });
      out[family] = ctx.measureText('Hello').width;
    }
    return out;
  }, bytes);
  expect(widths.Dee3).toBeGreaterThan(150);
  for (const family of ['3Dee', '04B_03__', 'Default']) expect(widths[family], family).toBeCloseTo(widths.Dee3, 3);
});

test('a cursor whose spring scale overshoots below 0 during a click renders on a real canvas', async ({ page }) => {
  const spring = { type: 'spring', stiffness: 170, damping: 14, mass: 1 };
  const cursor = { ...L, id: 'c', name: 'Cursor', type: 'cursor', duration: 1, anchorX: 0.5, x: 0, y: 0, points: [{ id: 'p1', x: 200, y: 150, time: 0 }], clicks: [{ id: 'k1', time: 0.75 }],
    smoothing: 0.5, size: 48, color: '#ffffff', rippleColor: '#4f7cff66', keyframes: { scale: [{ id: 'a', time: 0.4, value: 1, easing: spring }, { id: 'b', time: 1, value: 0, easing: spring }] } };
  const p = oneScene({}, [cursor]);
  await openRenderPage(page);
  const errors = await page.evaluate(async (p) => {
    const out: string[] = [];
    for (let f = 20; f < 30; f++) {
      try {
        await (window as any).motion.render(p, f / 30);
      } catch (e) {
        out.push(`frame ${f}: ${(e as Error).message}`);
      }
    }
    return out;
  }, p);
  expect(errors).toEqual([]);
});
