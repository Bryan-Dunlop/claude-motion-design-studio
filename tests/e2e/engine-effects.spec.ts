// A1 layer effects in real Chromium: pixel checks (isolation keeps fills clean, the default cursor stays visible),
// export-vs-renderFrame match, the 4K performance guard, determinism, and the Effects section UI.
import { expect, test } from '@playwright/test';
import { ProjectSchema, type Project, type ProjectInput } from '../../src/shared/schema';
import { expectExportMatchesRender, runExport, saveProject } from './exportCompare';
import { browserImport, getState, layerOf, openRenderPage, past } from './helpers';

const base = { visible: true, locked: false, start: 0, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1, keyframes: {} };

function project(width: number, height: number, durationSec: number, layers: unknown[], background = '#e0e0e0'): Project {
  const p: ProjectInput = {
    schemaVersion: 2,
    settings: { durationSec, aspect: 'custom', width, height, fps: 30, background },
    assets: [],
    scenes: [{ id: 's', name: 'S', start: 0, duration: durationSec, layers: layers as ProjectInput['scenes'][number]['layers'] }],
  };
  return ProjectSchema.parse(p);
}

/** Render `p` at the given times with renderFrame on a real canvas and sample pixels (browser side). */
async function sample(page: import('@playwright/test').Page, p: Project, times: number[], points: [number, number][]) {
  return browserImport(
    page,
    '/src/shared/renderFrame.ts',
    async (mod, arg: { p: Project; times: number[]; points: [number, number][] }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createRenderCanvas, createCanvasPool } = await load('/src/shared/canvas.ts');
      const { ctx } = createRenderCanvas(arg.p.settings.width, arg.p.settings.height);
      const pool = createCanvasPool();
      return arg.times.map((t) => {
        mod.renderFrame(arg.p, t, ctx, 1, { images: new Map(), canvasPool: pool });
        return arg.points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)) as number[]);
      });
    },
    { p, times, points },
  );
}

const near = (a: number[], b: number[], tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** Lay out in 960×540 design units, export at 1920×1080 (4:2:0 chroma loss at sharp colour edges matters less). */
const S = 2;
const SIZED = ['x', 'y', 'width', 'height', 'fontSize', 'cornerRadius', 'strokeWidth', 'blur', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'size'];
function at1080<T extends Record<string, unknown>>(layer: T): T {
  const out: Record<string, unknown> = { ...layer };
  for (const k of SIZED) if (typeof out[k] === 'number') out[k] = (out[k] as number) * S;
  const kf = layer.keyframes as Record<string, { value: unknown }[]>;
  out.keyframes = Object.fromEntries(Object.entries(kf).map(([prop, keys]) => [prop, SIZED.includes(prop) ? keys.map((k) => ({ ...k, value: (k.value as number) * S })) : keys]));
  if (Array.isArray(out.points)) out.points = (out.points as { x: number; y: number }[]).map((pt) => ({ ...pt, x: pt.x * S, y: pt.y * S }));
  return out as T;
}

/** Ctrl+Z as the user does it: shortcuts are ignored while a form control has focus. */
async function undo(page: import('@playwright/test').Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
}

test('a stroked rect with a drop shadow keeps its fill colour (the outline casts no shadow onto the fill)', async ({ page }) => {
  // 200×100 box at (100..300, 100..200), 20 px white outline, hard shadow offset 30 px.
  const p = project(400, 300, 1, [
    { ...base, id: 'r', name: 'R', type: 'shape', duration: 1, x: 200, y: 150, shape: 'rect', width: 200, height: 100, cornerRadius: 0, fill: '#4f7cff', stroke: '#ffffff', strokeWidth: 20,
      shadow: true, shadowColor: '#000000cc', shadowBlur: 0, shadowOffsetX: 30, shadowOffsetY: 30 },
  ]);
  // (130, 160): inside the fill where the outline's shadow would land if each draw call cast its own.
  // (320, 225): outside the layer, inside its shadow. (95, 150): the outline.
  const [[fill, shadow, outline]] = await sample(page, p, [0.5], [[130, 160], [320, 225], [95, 150]]);
  expect(near(fill, [0x4f, 0x7c, 0xff]), `fill pixel ${fill}`).toBe(true);
  expect(Math.max(...shadow)).toBeLessThan(80);
  expect(Math.min(...outline)).toBeGreaterThan(245);
});

test('the default cursor (drop shadow on) is visible at t = 0 and t = 1 s', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-cursor').click();
  const cursor = await layerOf(page, 'Cursor');
  expect(cursor).toMatchObject({ type: 'cursor', shadow: true });
  const project = (await getState(page)).project;
  project.settings.background = '#ffffff'; // light, so the shadow shows
  const r = await browserImport(
    page,
    '/src/shared/renderFrame.ts',
    async (mod, p: Project) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createRenderCanvas, createCanvasPool } = await load('/src/shared/canvas.ts');
      const scale = 0.5;
      const { ctx } = createRenderCanvas(p.settings.width * scale, p.settings.height * scale);
      const layer = p.scenes[0].layers[0] as Extract<Project['scenes'][number]['layers'][number], { type: 'cursor' }>;
      const s = (layer.size / 24) * layer.scale * scale;
      return [0, 1].map((t) => {
        mod.renderFrame(p, t, ctx, scale, { images: new Map(), canvasPool: createCanvasPool() });
        const pos = mod.cursorPosition(layer, t);
        const px = (ux: number, uy: number) => Array.from(ctx.getImageData(Math.round(pos.x * scale + ux * s), Math.round(pos.y * scale + uy * s), 1, 1).data.slice(0, 3)) as number[];
        // Inside the white arrow, and just below its tail (the shadow falls downwards).
        return { arrow: px(3, 12), background: px(-12, -12), belowTail: px(11, 30.2) };
      });
    },
    project,
  );
  for (const { arrow, background, belowTail } of r) {
    expect(Math.min(...arrow)).toBeGreaterThan(230); // the white arrow is drawn (not clipped away)
    expect(background).toEqual([255, 255, 255]);
    expect(Math.max(...belowTail)).toBeLessThan(245); // its shadow falls just below the tail
  }
});

test('export matches renderFrame for stroked, shadowed, blended and blurred layers', async ({ page, request }) => {
  const kx = (a: number, b: number) => ({ x: [{ id: 'k1', time: 0, value: a, easing: { type: 'easeInOut' } }, { id: 'k2', time: 1, value: b, easing: { type: 'linear' } }] });
  const p = project(960 * S, 540 * S, 1, [
    { ...base, id: 'band', name: 'Band', type: 'shape', duration: 1, x: 480, y: 380, shape: 'rect', width: 960, height: 200, cornerRadius: 0, fill: '#ffcc00', stroke: '#000', strokeWidth: 0 },
    { ...base, id: 'card', name: 'Card', type: 'shape', duration: 1, x: 250, y: 200, shape: 'rect', width: 260, height: 160, cornerRadius: 18, fill: '#4f7cff', stroke: '#ffffff', strokeWidth: 10,
      shadow: true, shadowColor: '#00000080', shadowBlur: 24, shadowOffsetX: 0, shadowOffsetY: 12, keyframes: kx(200, 320) },
    { ...base, id: 'mul', name: 'Multiply', type: 'shape', duration: 1, x: 700, y: 380, shape: 'ellipse', width: 300, height: 300, cornerRadius: 0, fill: '#ff3366', stroke: '#00ccff', strokeWidth: 14, blendMode: 'multiply' },
    { ...base, id: 'scr', name: 'Screen', type: 'shape', duration: 1, x: 520, y: 420, shape: 'rect', width: 180, height: 120, cornerRadius: 0, fill: '#3366ff', stroke: '#000', strokeWidth: 0, blendMode: 'screen', blur: 4 },
    { ...base, id: 'title', name: 'Title', type: 'text', duration: 1, x: 640, y: 120, content: 'Soft shadow\nand blur', fontFamily: 'Inter', fontSize: 54, fontWeight: 800, lineHeight: 1.1, letterSpacing: 0, align: 'center', color: '#1b2340',
      blur: 1.5, shadow: true, shadowColor: '#00000066', shadowBlur: 10, shadowOffsetX: 4, shadowOffsetY: 6, keyframes: { opacity: [{ id: 'o1', time: 0, value: 0.3, easing: { type: 'linear' } }, { id: 'o2', time: 1, value: 1, easing: { type: 'linear' } }] } },
    { ...base, id: 'cur', name: 'Cursor', type: 'cursor', duration: 1, x: 0, y: 0, anchorX: 0, anchorY: 0, points: [{ id: 'p1', x: 120, y: 450, time: 0 }, { id: 'p2', x: 800, y: 150, time: 0.9 }],
      clicks: [{ id: 'c1', time: 0.5 }], smoothing: 0.5, size: 34, color: '#ffffff', rippleColor: '#ffffff66', shadow: true, shadowColor: '#00000059', shadowBlur: 5, shadowOffsetY: 2 },
  ].map(at1080));
  const name = `Effects export ${Date.now()}`;
  await saveProject(request, name, p);
  const job = await runExport(request, { project: p, name });
  await expectExportMatchesRender(page, { project: p, projectName: name, mp4: job.outFile, frames: [0, 15, 29], wrongFrame: (f) => (f === 0 ? 29 : 0) });
});

test('4K performance guard: 3 blurred layers + a 12-word "Blur in" text render in < 400 ms', async ({ page }) => {
  const words = 'Ship faster with Motion Studio and make promo videos in minutes today';
  expect(words.split(' ')).toHaveLength(12);
  const rect = (id: string, x: number, over: object = {}) => ({ ...base, id, name: id, type: 'shape', duration: 4, x, y: 600, shape: 'rect', width: 700, height: 420, cornerRadius: 40, fill: '#4f7cff', stroke: '#ffffff', strokeWidth: 0, blur: 20, ...over });
  const p = project(3840, 2160, 4, [
    rect('a', 700),
    rect('b', 1900, { strokeWidth: 16, shadow: true, shadowBlur: 48, shadowOffsetY: 16 }),
    rect('c', 3100, { blendMode: 'screen' }),
    { ...base, id: 't', name: 't', type: 'text', duration: 4, x: 1920, y: 1500, content: words, fontFamily: 'Inter', fontSize: 120, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center', color: '#ffffff',
      textIn: { unit: 'word', effect: 'blur', order: 'forward', stagger: 0.06, duration: 0.6, delay: 0, distance: 18, easing: { type: 'easeOut' }, seed: 1, caret: false } },
  ], '#1b2340');
  await openRenderPage(page);
  const ms = await page.evaluate(async (p) => {
    const m = (window as any).motion;
    await m.render(p, 0.4); // warm-up (fonts, canvases)
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await m.render(p, 0.4); // mid-animation of the "Blur in"
      times.push(performance.now() - t0);
    }
    return times;
  }, p);
  console.log(`4K window.motion.render: ${ms.map((x) => x.toFixed(0)).join(', ')} ms`);
  // Best of three: the machine may be busy with other work; the unclipped-blur regression costs ~1000 ms every time.
  expect(Math.min(...ms)).toBeLessThan(400);
});

test('renderFrame stays deterministic with isolated effect layers and transitions, also when frames are interleaved', async ({ page }) => {
  const p = ProjectSchema.parse({
    schemaVersion: 2,
    settings: { durationSec: 4, aspect: '16:9', width: 960, height: 540, fps: 30, background: '#101828' },
    assets: [],
    scenes: [
      { id: 'a', name: 'A', start: 0, duration: 2.2, background: '#2d1b40', layers: [
        { ...base, id: 'r', name: 'R', type: 'shape', duration: 2.2, x: 300, y: 270, shape: 'rect', width: 240, height: 160, cornerRadius: 12, fill: '#4f7cff', stroke: '#ffffff', strokeWidth: 8,
          shadow: true, shadowColor: '#000000aa', shadowBlur: 16, shadowOffsetY: 8, blur: 1, keyframes: { rotation: [{ id: 'k1', time: 0, value: 0, easing: { type: 'easeInOut' } }, { id: 'k2', time: 2.2, value: 40, easing: { type: 'linear' } }] } },
        { ...base, id: 'c', name: 'C', type: 'cursor', duration: 2.2, x: 0, y: 0, anchorX: 0, anchorY: 0, points: [{ id: 'p', x: 500, y: 300, time: 0 }, { id: 'q', x: 700, y: 200, time: 1 }],
          clicks: [{ id: 'k', time: 1.1 }], smoothing: 0.5, size: 30, color: '#ffffff', rippleColor: '#ffffff66', shadow: true, shadowBlur: 6, shadowOffsetY: 3 },
      ] },
      { id: 'b', name: 'B', start: 1.8, duration: 2.2, transition: { type: 'blur', duration: 0.6, direction: 'left', easing: { type: 'easeInOut' } }, layers: [
        { ...base, id: 't', name: 'T', type: 'text', duration: 2.2, x: 480, y: 270, content: 'Two\nlines', fontFamily: 'Inter', fontSize: 70, fontWeight: 800, lineHeight: 1.1, letterSpacing: 0, align: 'center', color: '#ffcc00', blendMode: 'screen', shadow: true, shadowOffsetX: 6, shadowOffsetY: 6 },
      ] },
      { id: 'c2', name: 'C2', start: 3, duration: 1, background: '#335533', transition: { type: 'push', duration: 0.5, direction: 'up', easing: { type: 'easeOut' } }, layers: [] },
    ],
  });
  await openRenderPage(page);
  const times = [0.5, 1.15, 1.95, 2.1, 3.2];
  const first = await page.evaluate(async ({ p, times }) => {
    const m = (window as any).motion;
    const out: string[] = [];
    for (const t of times) out.push((await m.render(p, t)).sha256);
    return out;
  }, { p, times });
  const second = await page.evaluate(async ({ p, times }) => {
    const m = (window as any).motion;
    const out: Record<number, string> = {};
    for (const t of [...times].reverse()) {
      await m.render(p, t + 0.137);
      out[t] = (await m.render(p, t)).sha256;
    }
    return times.map((t: number) => out[t]);
  }, { p, times });
  expect(second).toEqual(first);
  expect(new Set(first).size).toBe(times.length);
});

test('Effects section: collapsed until used, drop-shadow defaults in one undo step, grouped blend modes', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  const section = page.getByTestId('effects-section');
  await expect(section).not.toHaveAttribute('open');
  await expect(section.locator('summary')).toHaveText('Effects');
  await section.locator('summary').click();

  // ☐ Drop shadow: first tick fills in a soft shadow sized for the 3840×2160 frame, as ONE undo step.
  const h = await past(page);
  await page.getByTestId('effects-shadow').check();
  expect(await past(page)).toBe(h + 1);
  expect(await layerOf(page, 'Rectangle')).toMatchObject({ shadow: true, shadowColor: '#00000040', shadowOffsetY: 16, shadowBlur: 48, shadowOffsetX: 0 });
  await expect(section.locator('summary')).toHaveText('Effects●');
  for (const id of ['prop-shadowColor', 'prop-shadowBlur', 'prop-shadowOffsetX', 'prop-shadowOffsetY', 'kf-toggle-shadowBlur', 'kf-toggle-shadowOffsetY']) await expect(page.getByTestId(id)).toBeVisible();

  // Changing a value, unticking and ticking again keeps the user's values (defaults only fill blank shadows).
  await page.getByTestId('prop-shadowBlur').fill('10');
  await page.getByTestId('prop-shadowBlur').press('Enter');
  await page.getByTestId('effects-shadow').uncheck();
  await expect(page.getByTestId('prop-shadowBlur')).toHaveCount(0);
  await page.getByTestId('effects-shadow').check();
  expect(await layerOf(page, 'Rectangle')).toMatchObject({ shadow: true, shadowBlur: 10, shadowOffsetY: 16 });
  await expect(section).toHaveAttribute('open'); // unticking didn't snap the section shut

  // Undo walks back one step at a time.
  await undo(page);
  expect((await layerOf(page, 'Rectangle')).shadow).toBe(false);
  await undo(page);
  expect((await layerOf(page, 'Rectangle')).shadow).toBe(true);

  // Blur is animatable (◆) and accepts a value.
  await expect(page.getByTestId('kf-toggle-blur')).toBeVisible();
  await page.getByTestId('prop-blur').fill('6');
  await page.getByTestId('prop-blur').press('Enter');
  expect((await layerOf(page, 'Rectangle')).blur).toBe(6);

  // Blend: Normal first, then the grouped modes.
  const blend = page.getByTestId('prop-blendMode');
  await expect(blend).toHaveAttribute('title', "How this layer mixes with what's behind it. Multiply darkens, Screen lightens.");
  expect(await blend.locator('optgroup').evaluateAll((gs) => gs.map((g) => `${(g as HTMLOptGroupElement).label}: ${[...g.querySelectorAll('option')].map((o) => o.textContent).join(', ')}`))).toEqual([
    'Darken: Multiply, Darken, Colour burn',
    'Lighten: Screen, Lighten, Colour dodge',
    'Contrast: Overlay, Soft light, Hard light',
    'Difference: Difference, Exclusion',
    'Colour: Hue, Saturation, Colour, Luminosity',
  ]);
  await expect(blend.locator(':scope > option')).toHaveText(['Normal']);
  await blend.selectOption('multiply');
  expect((await layerOf(page, 'Rectangle')).blendMode).toBe('multiply');

  // A layer without effects shows the section closed; selecting the effect layer again opens it.
  await page.getByTestId('add-text').click();
  await expect(page.getByTestId('effects-section')).not.toHaveAttribute('open');
  await page.getByTestId('layer-item-Rectangle').locator('.name').click();
  await expect(page.getByTestId('effects-section')).toHaveAttribute('open');
});

test('slide preset direction uses the same arrow labels as transitions', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await page.getByText('Animation presets').click();
  await page.getByTestId('preset-kind').selectOption('slide');
  await expect(page.getByTestId('preset-direction').locator('option')).toHaveText(['↑ Bottom to top', '↓ Top to bottom', '← Right to left', '→ Left to right']);
  await page.getByTestId('preset-direction').selectOption('left');
  await page.getByTestId('preset-apply').click();
  expect(Object.keys((await layerOf(page, 'Rectangle')).keyframes).sort()).toEqual(['opacity', 'x']);
});
