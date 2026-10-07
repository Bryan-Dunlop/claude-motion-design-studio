// A2 text animators in real Chromium: per-unit drawing keeps kerning (pixel-identical to whole lines at rest), the
// export matches renderFrame mid-animation, frames are deterministic, and the "Text animation" UI (styles, preview,
// customise) makes one undo step per edit.
import { expect, test, type Page } from '@playwright/test';
import { ProjectSchema, type Project, type TextAnim, type TextLayer } from '../../src/shared/schema';
import { expectExportMatchesRender, runExport, saveProject } from './exportCompare';
import { browserImport, getState, layerOf, openRenderPage, past } from './helpers';

const base = { visible: true, locked: false, start: 0, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1, keyframes: {} };
const text = (id: string, content: string, x: number, y: number, duration: number, over: object = {}) => ({
  ...base, id, name: id, type: 'text', duration, x, y, content, fontFamily: 'Inter', fontSize: 48, fontWeight: 800, lineHeight: 1.15, letterSpacing: 0, align: 'center', color: '#ffffff', ...over,
});
/** The editor's text layer (added with "+ Text"). */
const textLayer = async (page: Page) => (await layerOf(page, 'Text')) as TextLayer;
const A = (over: Partial<TextAnim>): TextAnim => ({ unit: 'word', effect: 'fade', order: 'forward', stagger: 0.08, duration: 0.5, delay: 0, distance: 0, easing: { type: 'easeOut' }, seed: 1, caret: false, ...over });

function project(width: number, height: number, durationSec: number, layers: unknown[], background = '#1b2340'): Project {
  return ProjectSchema.parse({
    schemaVersion: 2,
    settings: { durationSec, aspect: 'custom', width, height, fps: 30, background },
    assets: [],
    scenes: [{ id: 's', name: 'S', start: 0, duration: durationSec, layers }],
  });
}

/** Lay out in 960×540 design units, export at 1920×1080 (4:2:0 chroma loss at sharp colour edges matters less). */
const S = 2;
const SIZED = ['x', 'y', 'fontSize', 'blur', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY'];
function at1080<T extends Record<string, unknown>>(layer: T): T {
  const out: Record<string, unknown> = { ...layer };
  for (const k of SIZED) if (typeof out[k] === 'number') out[k] = (out[k] as number) * S;
  for (const k of ['textIn', 'textOut']) if (out[k]) out[k] = { ...(out[k] as TextAnim), distance: (out[k] as TextAnim).distance * S };
  return out as T;
}

/**
 * Per-unit drawing with every unit at rest (e = 1) vs the whole line drawn by renderFrame: max channel difference and
 * how many bytes differ — for the kerning-safe x (measureText(prefix + unit) − measureText(unit)) and, to show the
 * check is sensitive, for the naive x (measureText(prefix)).
 */
async function unitsVsLine(page: Page, p: Project, kind: TextAnim['unit'], scale: number) {
  return browserImport(
    page,
    '/src/shared/renderFrame.ts',
    async (mod, arg: { p: Project; kind: TextAnim['unit']; scale: number }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createRenderCanvas } = await load('/src/shared/canvas.ts');
      const geo = await load('/src/shared/geometry.ts');
      const ta = await load('/src/shared/textAnim.ts');
      const { p, kind, scale } = arg;
      const layer = p.scenes[0].layers[0] as any;
      await document.fonts.load(`${layer.fontWeight} 32px "${layer.fontFamily}"`);
      await document.fonts.ready;
      const W = Math.round(p.settings.width * scale);
      const H = Math.round(p.settings.height * scale);
      const whole = createRenderCanvas(W, H).ctx;
      mod.renderFrame(p, 0, whole, scale, { images: new Map() });
      const rest = { alpha: 1, s: 1, tx: 0, ty: 0, blurs: [] };
      const perUnit = (naive: boolean) => {
        const ctx = createRenderCanvas(W, H).ctx;
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.fillStyle = p.settings.background;
        ctx.fillRect(0, 0, p.settings.width, p.settings.height);
        const m = geo.layerMatrix(layer, geo.layerBox(ctx, layer));
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        const units = ta.layoutUnits(ctx, layer, kind);
        const lineStart = units[0].x;
        ctx.save();
        ctx.font = geo.fontString(layer);
        geo.setLetterSpacing(ctx, layer.letterSpacing);
        const naiveX = (u: any) => lineStart + ctx.measureText(layer.content.slice(0, u.start)).width;
        const placed = units.map((u: any) => ({ ...u, x: naive ? naiveX(u) : u.x, look: rest }));
        ctx.restore();
        mod.drawTextUnits(ctx, layer, placed, scale, geo.multiplyMatrix([scale, 0, 0, scale, 0, 0], m));
        return ctx;
      };
      const diff = (ctx: any) => {
        const a = whole.getImageData(0, 0, W, H).data;
        const b = ctx.getImageData(0, 0, W, H).data;
        let max = 0;
        let bytes = 0;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i] - b[i]);
          if (d) bytes++;
          if (d > max) max = d;
        }
        return { max, bytes };
      };
      return { kerned: diff(perUnit(false)), naive: diff(perUnit(true)), units: ta.layoutUnits(whole, layer, kind).length };
    },
    { p, kind, scale },
  );
}

test("kerned 'AVATAR': per-letter drawing at e = 1 is pixel-identical to the whole line (the naive prefix width is not)", async ({ page }) => {
  const cases: [Project, TextAnim['unit'], number][] = [
    [project(1200, 400, 1, [text('k', 'AVATAR', 600.3, 200, 1, { fontSize: 180 })]), 'char', 1],
    [project(1200, 400, 1, [text('k', 'AVATAR Type Wave', 613, 210, 1, { fontSize: 110, fontWeight: 700, letterSpacing: 3, rotation: -4 })]), 'char', 0.75],
    [project(1200, 400, 1, [text('k', 'AVATAR Type Wave', 613, 210, 1, { fontSize: 110, fontWeight: 400, align: 'right', scale: 1.3 })]), 'word', 1],
  ];
  for (const [p, kind, scale] of cases) {
    const r = await unitsVsLine(page, p, kind, scale);
    console.log(`${(p.scenes[0].layers[0] as { content: string }).content} by ${kind} @${scale}: kerned max diff ${r.kerned.max}, naive max diff ${r.naive.max} (${r.naive.bytes} bytes)`);
    expect(r.units).toBeGreaterThan(2);
    expect(r.kerned).toEqual({ max: 0, bytes: 0 });
    // Letters sit inside kern pairs (AV, VA, AT, TA…), so the naive x is visibly off; words start after a space.
    if (kind === 'char') expect(r.naive.max).toBeGreaterThan(100);
  }
});

test('right-to-left lines: words (and Hebrew letters) at rest sit exactly where the whole line draws them', async ({ page }) => {
  // Before: units were placed left to right in reading order, so the first Hebrew word was drawn on the left.
  const cases: [Project, TextAnim['unit']][] = [
    [project(1200, 400, 1, [text('h', 'שלום עולם יפה', 600, 200, 1, { fontSize: 110, fontWeight: 700 })]), 'word'],
    [project(1200, 400, 1, [text('h', 'שלום עולם', 600, 200, 1, { fontSize: 110, fontWeight: 700, align: 'right' })]), 'char'],
    [project(1200, 400, 1, [text('a', 'مرحبا بالعالم', 600, 200, 1, { fontSize: 110, fontWeight: 400 })]), 'word'],
  ];
  for (const [p, kind] of cases) {
    const r = await unitsVsLine(page, p, kind, 1);
    console.log(`${(p.scenes[0].layers[0] as { content: string }).content} by ${kind}: max diff ${r.kerned.max} (${r.kerned.bytes} bytes)`);
    expect(r.units).toBeGreaterThan(1);
    expect(r.kerned).toEqual({ max: 0, bytes: 0 });
  }
});

test('a typewriter half-way through draws the typed letters exactly where the whole line puts them', async ({ page }) => {
  // Left-aligned with the anchor on the left edge, so 'AVATAR ' sits at the same place in both projects.
  const over = { align: 'left', anchorX: 0, fontSize: 120 };
  const typing = project(1280, 360, 2, [text('t', 'AVATAR Type Wave', 60, 180, 2, { ...over, textIn: A({ unit: 'char', effect: 'typewriter', stagger: 0.1, duration: 0.1 }) })]);
  const typed = project(1280, 360, 2, [text('t', 'AVATAR ', 60, 180, 2, over)]);
  const other = project(1280, 360, 2, [text('t', 'AVATAR T', 60, 180, 2, over)]);
  await openRenderPage(page);
  const [a, b, c] = await page.evaluate(
    async ({ typing, typed, other }) => {
      const m = (window as any).motion;
      // t = 0.65: letters 0–6 have started ('AVATAR '), the 'T' starts at 0.7.
      return [(await m.render(typing, 0.65)).sha256, (await m.render(typed, 0)).sha256, (await m.render(other, 0)).sha256];
    },
    { typing, typed, other },
  );
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

/** 1920×1080, 1.5 s: every style family mid-animation, in and out, one text isolated by a drop shadow. */
function animatedProject(): Project {
  return project(960 * S, 540 * S, 1.5, [
    { ...text('words', 'Ship faster today', 480, 70, 1.5), textIn: A({ effect: 'rise', distance: 24 }), textOut: A({ stagger: 0.04, duration: 0.3, easing: { type: 'easeIn' } }) },
    { ...text('letters', 'Letters fade in', 480, 150, 1.5, { shadow: true, shadowColor: '#000000aa', shadowBlur: 8, shadowOffsetY: 5 }), textIn: A({ unit: 'char', stagger: 0.03, duration: 0.4 }) },
    { ...text('blur', 'Blur in words', 480, 230, 1.5, { color: '#ffcc00' }), textIn: A({ effect: 'blur', stagger: 0.06, duration: 0.6, distance: 7 }) },
    { ...text('type', 'Typing this out', 480, 310, 1.5, { fontWeight: 600 }), textIn: A({ unit: 'char', effect: 'typewriter', stagger: 0.05, duration: 0.05, caret: true, easing: { type: 'linear' } }) },
    { ...text('lines', 'Lines slide up\nthen grow away', 300, 430, 1.5, { fontSize: 36 }),
      textIn: A({ unit: 'line', effect: 'rise', stagger: 0.15, duration: 0.6, distance: 29 }), textOut: A({ unit: 'line', effect: 'scale', stagger: 0.1, duration: 0.4, easing: { type: 'spring', stiffness: 200, damping: 12, mass: 1 } }) },
    { ...text('riseout', 'Rising out', 720, 440, 1.5, { fontSize: 40, color: '#7ee0ff' }), textOut: A({ unit: 'char', effect: 'rise', stagger: 0.03, duration: 0.3, distance: 30, order: 'center' }) },
  ].map(at1080));
}

test('export matches renderFrame mid-animation (rise, letters, blur, typewriter + caret, lines, grow-out, rise-out, an isolated layer)', async ({ page, request }) => {
  const p = animatedProject();
  const name = `Text animation export ${Date.now()}`;
  await saveProject(request, name, p);
  const job = await runExport(request, { project: p, name });
  // 0.2 s and 0.5 s: in phases running; 1.33 s: out phases running (and the caret blinked on).
  await expectExportMatchesRender(page, { project: p, projectName: name, mp4: job.outFile, frames: [6, 15, 40], wrongFrame: (f) => (f === 6 ? 15 : 6) });
});

test('renderFrame stays deterministic for animated text, also when frames are interleaved', async ({ page }) => {
  const p = animatedProject();
  await openRenderPage(page);
  const times = [0.12, 0.3, 0.71, 1.2, 1.33];
  const first = await page.evaluate(async ({ p, times }) => {
    const m = (window as any).motion;
    const out: string[] = [];
    for (const t of times) out.push((await m.render(p, t, { scale: 0.5 })).sha256);
    return out;
  }, { p, times });
  const second = await page.evaluate(async ({ p, times }) => {
    const m = (window as any).motion;
    const out: Record<number, string> = {};
    for (const t of [...times].reverse()) {
      await m.render(p, t + 0.137, { scale: 0.5 });
      out[t] = (await m.render(p, t, { scale: 0.5 })).sha256;
    }
    return times.map((t: number) => out[t]);
  }, { p, times });
  expect(second).toEqual(first);
  expect(new Set(first).size).toBe(times.length);
});

test('Text animation section: apply a style, preview it, customise it (fields per effect), one undo step per edit', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-text').click();
  const section = page.getByTestId('textanim-section');
  const summary = section.locator('summary').first();
  await expect(section).not.toHaveAttribute('open');
  await expect(summary).toHaveText('Text animation');
  await summary.click();
  await expect(page.getByTestId('textanim-in-style').locator('option')).toHaveText(['None', 'Words rise', 'Letters fade', 'Typewriter', 'Lines slide up', 'Blur in']);
  await expect(page.getByTestId('textanim-out-style').locator('option')).toHaveText(['None', 'Words fade out', 'Backspace']);
  await expect(page.getByTestId('textanim-in-preview')).toHaveCount(0);
  await expect(page.getByTestId('textanim-in-customise')).toHaveCount(0);
  for (const id of ['textanim-in-style', 'textanim-out-style']) await expect(page.getByTestId(id)).toHaveAttribute('title', /.+/);

  // Words rise: one undo step; its distance is half the font size (173 px text at 4K → 87 px).
  let h = await past(page);
  await page.getByTestId('textanim-in-style').selectOption('words-rise');
  expect(await past(page)).toBe(h + 1);
  expect((await textLayer(page)).textIn).toEqual({ unit: 'word', effect: 'rise', order: 'forward', stagger: 0.08, duration: 0.5, delay: 0, distance: 87, easing: { type: 'easeOut' }, seed: 1, caret: false });
  await expect(summary).toHaveText('Text animation●');

  // ▶ Preview plays the start of the layer once: up to 0.5 s after the last word ("Your text": 0.08 + 0.5 s) lands.
  await expect(page.getByTestId('textanim-in-preview')).toHaveAttribute('title', 'Play the start of this layer once to see the animation');
  await page.getByTestId('textanim-in-preview').click();
  await expect.poll(() => page.evaluate(() => (window as any).__motion.useEditor.getState().playUntil)).toBeCloseTo(0.58 + 0.5, 5);
  await expect.poll(() => page.evaluate(() => (window as any).__motion.useEditor.getState().playing), { timeout: 5000 }).toBe(false);
  expect((await getState(page)).time).toBeCloseTo(1.08, 5);

  // Customise: the raw fields with plain labels.
  await page.getByTestId('textanim-in-customise').locator('summary').click();
  const label = (testId: string) => page.locator('.row', { has: page.getByTestId(testId) }).locator('.row-label');
  await expect(page.getByTestId('textanim-in-unit').locator('option')).toHaveText(['Letters', 'Words', 'Lines']);
  await expect(page.getByTestId('textanim-in-effect').locator('option')).toHaveText(['Fade', 'Move up', 'Move down', 'Grow', 'Typewriter', 'Blur']);
  await expect(page.getByTestId('textanim-in-order').locator('option')).toHaveText(['First to last', 'Last to first', 'Middle out', 'Edges in', 'Random']);
  await expect(label('textanim-in-stagger')).toHaveText('Gap between words (s)');
  await expect(label('textanim-in-duration')).toHaveText('Each takes (s)');
  await expect(label('textanim-in-delay')).toHaveText('Starts after (s)');
  await expect(label('textanim-in-distance')).toHaveText('Distance (px)');
  await expect(page.getByTestId('textanim-in-distance')).toHaveValue('87');
  await expect(page.getByTestId('textanim-in-easing')).toBeVisible();
  await expect(page.getByTestId('textanim-in-seed')).toHaveCount(0);
  await expect(page.getByTestId('textanim-in-caret')).toHaveCount(0);

  // A changed gap is one undo step and makes the style "Custom".
  h = await past(page);
  await page.getByTestId('textanim-in-stagger').fill('0.12');
  await page.getByTestId('textanim-in-stagger').press('Enter');
  expect(await past(page)).toBe(h + 1);
  expect((await textLayer(page)).textIn?.stagger).toBe(0.12);
  await expect(page.getByTestId('textanim-in-style')).toHaveValue('custom');

  // Blur: "Blur amount (px)" with a blur-sized start value (15 % of the font size).
  await page.getByTestId('textanim-in-effect').selectOption('blur');
  await expect(label('textanim-in-distance')).toHaveText('Blur amount (px)');
  await expect(page.getByTestId('textanim-in-distance')).toHaveValue('26');

  // Letters: the gap label follows (the changed gap is kept).
  await page.getByTestId('textanim-in-unit').selectOption('char');
  await expect(label('textanim-in-stagger')).toHaveText('Gap between letters (s)');
  await expect(page.getByTestId('textanim-in-stagger')).toHaveValue('0.12');

  // Typewriter: no length, easing or distance; a Caret box instead. Gap 0.05 + caret = the "Typewriter" style.
  await page.getByTestId('textanim-in-effect').selectOption('typewriter');
  for (const id of ['textanim-in-duration', 'textanim-in-easing', 'textanim-in-distance']) await expect(page.getByTestId(id)).toHaveCount(0);
  await page.getByTestId('textanim-in-stagger').fill('0.05');
  await page.getByTestId('textanim-in-stagger').press('Enter');
  h = await past(page);
  await page.getByTestId('textanim-in-caret').check();
  expect(await past(page)).toBe(h + 1);
  await expect(page.getByTestId('textanim-in-style')).toHaveValue('typewriter');
  expect((await textLayer(page)).textIn).toMatchObject({ unit: 'char', effect: 'typewriter', stagger: 0.05, caret: true });

  // Random order: a Shuffle number.
  await page.getByTestId('textanim-in-order').selectOption('random');
  await expect(label('textanim-in-seed')).toHaveText('Shuffle');

  // Out: Backspace; "Ends before layer end (s)"; ▶ Preview plays the end of the layer (the layer runs to the end of the video).
  await page.getByTestId('textanim-out-style').selectOption('backspace');
  await page.getByTestId('textanim-out-customise').locator('summary').click();
  await expect(label('textanim-out-delay')).toHaveText('Ends before layer end (s)');
  await page.getByTestId('textanim-out-preview').click();
  await expect.poll(() => page.evaluate(() => (window as any).__motion.useEditor.getState().playUntil)).toBe(15);
  // "Your text": 9 letters × 0.03 s → the deletion starts at 15 − 0.27 s; the preview starts 0.5 s before that.
  expect((await getState(page)).time).toBeGreaterThan(14.2);
  await expect.poll(() => page.evaluate(() => (window as any).__motion.useEditor.getState().playing), { timeout: 5000 }).toBe(false);

  // None removes an animation (one step); undo brings it back.
  h = await past(page);
  await page.getByTestId('textanim-out-style').selectOption('none');
  expect(await past(page)).toBe(h + 1);
  expect((await textLayer(page)).textOut).toBeNull();
  await expect(page.getByTestId('textanim-out-preview')).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await textLayer(page)).textOut?.effect).toBe('typewriter');
});
