// Determinism in the real browser: rendering the same t gives identical pixels, even when other frames
// (different times / features) are rendered in between — catches state leaking through scratch or pooled canvases.
import { expect, test } from '@playwright/test';
import { sampleProject } from '../fixtures/sampleProject';
import { browserImport, openRenderPage } from './helpers';

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
