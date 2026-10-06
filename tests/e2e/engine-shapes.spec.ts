// A3 shapes v2 in real Chromium: trimmed outlines start where the spec says and wrap without a seam, the outline length
// matches Skia's (a half-trimmed pill ends at the opposite point), text outlines never cover the fill, gradients run
// from From to To, the export matches renderFrame (deterministically), and the Shape / Draw outline / Typography / preset UI.
import { expect, test, type Page } from '@playwright/test';
import { ProjectSchema, type Project, type ShapeLayer, type TextLayer } from '../../src/shared/schema';
import { expectExportMatchesRender, runExport, saveProject } from './exportCompare';
import { browserImport, getState, layerOf, openRenderPage, past } from './helpers';

const base = { visible: true, locked: false, start: 0, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1, keyframes: {} };
const shape = (id: string, over: object) => ({
  ...base, id, name: id, type: 'shape', duration: 1, x: 300, y: 200, shape: 'rect', width: 400, height: 240, cornerRadius: 0, fill: '#00000000', stroke: '#ffffff', strokeWidth: 10, lineCap: 'butt', ...over,
});

function project(width: number, height: number, durationSec: number, layers: unknown[], background = '#000000'): Project {
  return ProjectSchema.parse({
    schemaVersion: 2,
    settings: { durationSec, aspect: 'custom', width, height, fps: 30, background },
    assets: [],
    scenes: [{ id: 's', name: 'S', start: 0, duration: durationSec, layers }],
  });
}

/** renderFrame on a real canvas at time t; returns [r, g, b] at each point. */
async function pixels(page: Page, p: Project, points: [number, number][], t = 0.5) {
  return browserImport(
    page,
    '/src/shared/renderFrame.ts',
    async (mod, arg: { p: Project; points: [number, number][]; t: number }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createRenderCanvas } = await load('/src/shared/canvas.ts');
      const { ctx } = createRenderCanvas(arg.p.settings.width, arg.p.settings.height);
      mod.renderFrame(arg.p, arg.t, ctx, 1, { images: new Map() });
      return arg.points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)) as number[]);
    },
    { p, points, t },
  );
}

const lum = (px: number[]) => Math.max(...px);

test('trimmed outlines start where they should and run clockwise: ellipse at 12 o’clock, rect just after its top-left corner', async ({ page }) => {
  // Ellipse box (100..500, 80..320): the first 5 % (~51 px) runs right from the top centre (300, 80).
  const ellipse = project(600, 400, 1, [shape('e', { shape: 'ellipse', trimEnd: 0.05 })]);
  const [right, left, further] = await pixels(page, ellipse, [[330, 80], [270, 80], [380, 90]]);
  expect(lum(right)).toBeGreaterThan(240);
  expect(lum(left)).toBeLessThan(10);
  expect(lum(further)).toBeLessThan(10);
  // Rect with 40 px corners: starts at (140, 80) heading right; the top-left corner arc stays undrawn.
  const rect = project(600, 400, 1, [shape('r', { cornerRadius: 40, trimEnd: 25 / 1211 })]);
  const [onEdge, onArc, past] = await pixels(page, rect, [[160, 80], [130, 81], [175, 80]]);
  expect(lum(onEdge)).toBeGreaterThan(240);
  expect(lum(onArc)).toBeLessThan(10);
  expect(lum(past)).toBeLessThan(10);
});

test('a trim that wraps past the start point is continuous: no gap and no doubled overlap', async ({ page }) => {
  // Visible part [0.95, 1.05] of a rounded rect: across its start point (140, 80), half-transparent white on black.
  const p = project(600, 400, 1, [shape('r', { cornerRadius: 40, trimStart: 0.9, trimEnd: 1, trimOffset: 0.05, stroke: '#ffffff80' })]);
  const edge = Array.from({ length: 40 }, (_, i) => [131 + i, 80] as [number, number]); // the arc's end, the start point, the edge
  const arc = [20, 35, 50, 65, 80].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return [Math.round(140 - 40 * Math.cos(a)), Math.round(120 - 40 * Math.sin(a))] as [number, number];
  });
  const values = (await pixels(page, p, [...edge, ...arc])).map((px) => px[0]);
  for (const v of values) expect(Math.abs(v - 128), `${values}`).toBeLessThanOrEqual(2);
});

test('a pill (r > h/2) trimmed to 50 % ends exactly opposite its start: the outline length matches Chromium’s', async ({ page }) => {
  // 400×120 pill with r = 500 (drawn with rr = 60) in the box (100..500, 140..260): starts at (160, 140), half the
  // outline later — the top edge plus the right half-circle — it reaches (440, 260).
  const p = project(600, 400, 1, [shape('pill', { width: 400, height: 120, cornerRadius: 500, trimEnd: 0.5 })]);
  const [arcEnd, bottomAfter, top] = await pixels(page, p, [[445, 260], [436, 260], [440, 140]]);
  expect(lum(arcEnd)).toBeGreaterThan(200);
  expect(lum(bottomAfter)).toBeLessThan(10);
  expect(lum(top)).toBeGreaterThan(240);
});

test('text outline is drawn before the fill: no fill pixel is covered (the opposite order covers many)', async ({ page }) => {
  const layer = { ...base, id: 't', name: 't', type: 'text', duration: 1, x: 400, y: 150, content: 'Outline', fontFamily: 'Inter', fontSize: 130, fontWeight: 900, lineHeight: 1.2, letterSpacing: 0, align: 'center', color: '#ffffff', stroke: '#ff0000' };
  const plain = project(800, 300, 1, [layer]);
  const outlined = project(800, 300, 1, [{ ...layer, strokeWidth: 16 }]);
  const r = await browserImport(
    page,
    '/src/shared/renderFrame.ts',
    async (mod, arg: { plain: Project; outlined: Project }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createRenderCanvas } = await load('/src/shared/canvas.ts');
      const geo = await load('/src/shared/geometry.ts');
      await document.fonts.load('900 32px Inter');
      const draw = (p: Project) => {
        const { ctx } = createRenderCanvas(800, 300);
        mod.renderFrame(p, 0.5, ctx, 1, { images: new Map() });
        return ctx;
      };
      const a = draw(arg.plain).getImageData(0, 0, 800, 300).data;
      const b = draw(arg.outlined).getImageData(0, 0, 800, 300).data;
      // The opposite order (fill, then outline) drawn by hand on the same layout.
      const l = arg.outlined.scenes[0].layers[0] as any;
      const { ctx: c } = createRenderCanvas(800, 300);
      c.fillStyle = '#000000';
      c.fillRect(0, 0, 800, 300);
      const m = geo.layerMatrix(l, geo.layerBox(c, l));
      c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      c.font = geo.fontString(l);
      c.textBaseline = 'middle';
      c.fillStyle = l.color;
      c.fillText(l.content, 0, (l.fontSize * l.lineHeight) / 2);
      c.lineJoin = 'round';
      c.lineWidth = l.strokeWidth;
      c.strokeStyle = l.stroke;
      c.strokeText(l.content, 0, (l.fontSize * l.lineHeight) / 2);
      const wrong = c.getImageData(0, 0, 800, 300).data;
      let fill = 0;
      let covered = 0;
      let coveredWrong = 0;
      let red = 0;
      for (let i = 0; i < a.length; i += 4) {
        const isFill = a[i] === 255 && a[i + 1] === 255 && a[i + 2] === 255;
        if (isFill) {
          fill++;
          if (b[i + 1] < 250) covered++;
          if (wrong[i + 1] < 250) coveredWrong++;
        }
        if (b[i] > 250 && b[i + 1] < 5) red++;
      }
      return { fill, covered, coveredWrong, red };
    },
    { plain, outlined },
  );
  console.log(`text outline: ${r.fill} fill pixels, ${r.covered} covered (fill-then-outline covers ${r.coveredWrong}), ${r.red} outline pixels`);
  expect(r.fill).toBeGreaterThan(5000);
  expect(r.covered).toBe(0);
  expect(r.coveredWrong).toBeGreaterThan(1000);
  expect(r.red).toBeGreaterThan(5000);
});

test('gradient fill runs from From to To across the box at the angle', async ({ page }) => {
  const g = (angle: number) => project(600, 400, 1, [shape('g', { width: 200, height: 100, strokeWidth: 0, fillMode: 'linear', fill: '#ff0000', gradientTo: '#0000ff', gradientAngle: angle })]);
  const [l, mid, r] = await pixels(page, g(0), [[201, 200], [300, 200], [398, 200]]);
  expect(l[0]).toBeGreaterThan(250);
  expect(l[2]).toBeLessThan(5);
  expect(r[2]).toBeGreaterThan(250);
  expect(r[0]).toBeLessThan(5);
  expect(Math.abs(mid[0] - 128)).toBeLessThan(4);
  expect(Math.abs(mid[2] - 128)).toBeLessThan(4);
  const [top, bottom] = await pixels(page, g(90), [[300, 151], [300, 248]]);
  expect(top[0]).toBeGreaterThan(245);
  expect(bottom[2]).toBeGreaterThan(245);
});

/** Lay out in 960×540 design units, export at 1920×1080 (4:2:0 chroma loss at sharp colour edges matters less). */
const S = 2;
const SIZED = ['x', 'y', 'width', 'height', 'fontSize', 'cornerRadius', 'strokeWidth'];
function at1080<T extends Record<string, unknown>>(layer: T): T {
  const out: Record<string, unknown> = { ...layer };
  for (const k of SIZED) if (typeof out[k] === 'number') out[k] = (out[k] as number) * S;
  return out as T;
}
const kf = (prop: string, a: number, b: number, t0 = 0, t1 = 1) => ({ [prop]: [{ id: `${prop}0`, time: t0, value: a, easing: { type: 'easeInOut' } }, { id: `${prop}1`, time: t1, value: b, easing: { type: 'linear' } }] });

/** 1920×1080, 1 s: a draw-on rect, gradient star, trimmed hexagon with a moving offset, two lines, a trimmed gradient
 * ellipse with square ends, a triangle and outlined gradient text. */
function shapesProject(): Project {
  return project(960 * S, 540 * S, 1, [
    shape('drawOn', { x: 170, y: 140, width: 240, height: 150, cornerRadius: 26, stroke: '#4f7cff', strokeWidth: 9, lineCap: 'round', keyframes: kf('trimEnd', 0, 1) }),
    shape('star', { x: 480, y: 150, width: 210, height: 210, shape: 'star', points: 5, innerRadius: 0.45, fill: '#ffd23f', fillMode: 'linear', gradientTo: '#ff5c5c', gradientAngle: 60, stroke: '#ffffff', strokeWidth: 6, keyframes: kf('rotation', 0, 40) }),
    shape('poly', { x: 790, y: 150, width: 200, height: 180, shape: 'polygon', points: 6, fill: '#22c55e', stroke: '#e6e7ea', strokeWidth: 8, trimStart: 0.1, trimEnd: 0.65, lineCap: 'round', keyframes: kf('trimOffset', 0, 0.8) }),
    shape('line', { x: 220, y: 330, width: 340, height: 20, shape: 'line', stroke: '#ff7a3d', strokeWidth: 14, lineCap: 'round', trimStart: 0.15, keyframes: kf('trimEnd', 0.3, 1) }),
    shape('square', { x: 220, y: 400, width: 300, height: 10, shape: 'line', stroke: '#7ee0ff', strokeWidth: 10, lineCap: 'square', rotation: -6 }),
    shape('ellipse', { x: 520, y: 380, width: 220, height: 150, shape: 'ellipse', fill: '#3d6be0', fillMode: 'linear', gradientTo: '#b38cff', gradientAngle: 0, stroke: '#ffffff', strokeWidth: 7, trimEnd: 0.7, lineCap: 'square', keyframes: kf('trimOffset', 0.25, -0.5) }),
    shape('tri', { x: 790, y: 390, width: 180, height: 156, shape: 'triangle', fill: '#ffb020', stroke: '#1b2340', strokeWidth: 10 }),
    { ...base, id: 'title', name: 'title', type: 'text', duration: 1, x: 480, y: 490, content: 'Shapes v2', fontFamily: 'Inter', fontSize: 64, fontWeight: 900, lineHeight: 1.1, letterSpacing: 1, align: 'center',
      color: '#ffffff', fillMode: 'linear', gradientTo: '#7ee0ff', gradientAngle: 90, stroke: '#4f7cff', strokeWidth: 6 },
  ].map(at1080), '#1b2340');
}

test('export matches renderFrame: trimmed outlines, star, polygon, lines, gradient fills, outlined gradient text', async ({ page, request }) => {
  const p = shapesProject();
  const name = `Shapes export ${Date.now()}`;
  await saveProject(request, name, p);
  const job = await runExport(request, { project: p, name });
  await expectExportMatchesRender(page, { project: p, projectName: name, mp4: job.outFile, frames: [5, 15, 27], wrongFrame: (f) => (f === 5 ? 27 : 5) });
});

test('renderFrame stays deterministic for trimmed and gradient shapes, also when frames are interleaved', async ({ page }) => {
  const p = shapesProject();
  await openRenderPage(page);
  const times = [0.1, 0.35, 0.6, 0.95];
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

/** Ctrl+Z as the user does it: shortcuts are ignored while a form control has focus. */
async function undo(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
}

async function setField(page: Page, testId: string, value: string) {
  await page.getByTestId(testId).fill(value);
  await page.getByTestId(testId).press('Enter');
}

const rectangle = async (page: Page) => (await layerOf(page, 'Rectangle')) as ShapeLayer;

test('Draw outline (trim): Add outline in one step, % fields with ◆, line ends while trimmed', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  const section = page.getByTestId('trim-section');
  const summary = section.locator('summary');
  await expect(section).not.toHaveAttribute('open');
  await expect(summary).toHaveText('Draw outline (trim)');
  await summary.click();

  // No outline yet: a hint and "Add outline" (width 1 % of the 2160 px short edge, see-through fill) as ONE undo step.
  await expect(page.getByTestId('trim-no-outline')).toContainText('Only the outline is drawn — add one first');
  await expect(page.getByTestId('trim-add-outline')).toHaveAttribute('title', /.+/);
  await expect(page.getByTestId('prop-stroke')).toHaveCount(0); // no outline colour until there is an outline
  let h = await past(page);
  await page.getByTestId('trim-add-outline').click();
  expect(await past(page)).toBe(h + 1);
  expect(await rectangle(page)).toMatchObject({ strokeWidth: 22, fill: '#4f7cff00' });
  await expect(page.getByTestId('trim-no-outline')).toHaveCount(0);
  await expect(page.getByTestId('prop-stroke')).toBeVisible();

  // Start / End / Offset are percentages of the outline (stored 0..1), each with a keyframe toggle.
  for (const p of ['trimStart', 'trimEnd', 'trimOffset']) await expect(page.getByTestId(`kf-toggle-${p}`)).toBeVisible();
  await expect(page.getByTestId('prop-trimEnd')).toHaveValue('100');
  await expect(page.getByTestId('prop-lineCap')).toHaveCount(0); // line ends only matter once trimmed
  h = await past(page);
  await setField(page, 'prop-trimEnd', '40');
  expect(await past(page)).toBe(h + 1);
  expect((await rectangle(page)).trimEnd).toBeCloseTo(0.4, 9);
  await expect(summary).toHaveText('Draw outline (trim)●');
  await setField(page, 'prop-trimOffset', '-25');
  expect((await rectangle(page)).trimOffset).toBeCloseTo(-0.25, 9);

  // Line ends: Round (default) / Flat / Square.
  await expect(page.getByTestId('prop-lineCap').locator('option')).toHaveText(['Round', 'Flat', 'Square']);
  await expect(page.getByTestId('prop-lineCap')).toHaveValue('round');
  await page.getByTestId('prop-lineCap').selectOption('square');
  expect((await rectangle(page)).lineCap).toBe('square');

  // ◆ on End % animates it: a keyframe at the playhead.
  await page.getByTestId('kf-toggle-trimEnd').click();
  expect((await rectangle(page)).keyframes.trimEnd).toHaveLength(1);

  // Undo walks back one step at a time.
  await undo(page);
  await undo(page);
  expect((await rectangle(page)).lineCap).toBe('round');
  await undo(page);
  await expect.poll(async () => (await rectangle(page)).trimOffset).toBe(0);
  await undo(page);
  await expect.poll(async () => (await rectangle(page)).trimEnd).toBe(1);
  await expect(page.getByTestId('prop-lineCap')).toHaveCount(0);

  // A layer whose trim is in use opens the section when selected; one without keeps it closed.
  await setField(page, 'prop-trimEnd', '50');
  await page.getByTestId('add-text').click();
  await page.getByTestId('layer-item-Rectangle').locator('.name').click();
  await expect(page.getByTestId('trim-section')).toHaveAttribute('open');
});

test('Shape section: sides / points / inner size per type, no fill for lines, Fill gradient with From / To / Angle', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  const label = (testId: string) => page.locator('.row', { has: page.getByTestId(testId) }).locator('.row-label');
  await expect(page.getByTestId('prop-points')).toHaveCount(0);

  await page.getByTestId('prop-shape').selectOption('polygon');
  await expect(label('prop-points')).toHaveText('Sides');
  await setField(page, 'prop-points', '8');
  expect((await rectangle(page)).points).toBe(8);
  await expect(page.getByTestId('prop-innerRadius')).toHaveCount(0);

  await page.getByTestId('prop-shape').selectOption('star');
  await expect(label('prop-points')).toHaveText('Points');
  await expect(label('prop-innerRadius')).toHaveText('Inner size');
  await expect(page.getByTestId('prop-innerRadius')).toHaveValue('45');
  await expect(page.getByTestId('kf-toggle-innerRadius')).toBeVisible();
  await setField(page, 'prop-innerRadius', '30');
  expect((await rectangle(page)).innerRadius).toBeCloseTo(0.3, 9);

  await page.getByTestId('prop-shape').selectOption('line');
  await expect(page.getByTestId('prop-fillMode')).toHaveCount(0);
  await expect(page.getByTestId('prop-fill')).toHaveCount(0);
  await expect(label('prop-strokeWidth')).toHaveText('Line width');
  await expect(label('prop-stroke')).toHaveText('Line colour');
  await expect(page.getByTestId('prop-lineCap')).toBeVisible();

  // Fill: Solid | Gradient. Gradient shows From / To / Angle (◆ each) and an arrow that turns with the angle.
  await page.getByTestId('prop-shape').selectOption('rect');
  await expect(page.getByTestId('prop-fillMode').locator('option')).toHaveText(['Solid', 'Gradient']);
  await expect(label('prop-fill')).toHaveText('Colour');
  const h = await past(page);
  await page.getByTestId('prop-fillMode').selectOption('linear');
  expect(await past(page)).toBe(h + 1);
  expect(await rectangle(page)).toMatchObject({ fillMode: 'linear', fill: '#4f7cff', gradientTo: '#ffffff' }); // different colours: kept
  await expect(label('prop-fill')).toHaveText('From');
  await expect(label('prop-gradientTo')).toHaveText('To');
  await expect(label('prop-gradientAngle')).toHaveText('Angle');
  for (const p of ['fill', 'gradientTo', 'gradientAngle']) await expect(page.getByTestId(`kf-toggle-${p}`)).toBeVisible();
  await expect(page.getByTestId('prop-gradientAngle')).toHaveValue('90');
  await expect(page.getByTestId('gradient-arrow')).toHaveAttribute('style', /rotate\(90deg\)/);
  await setField(page, 'prop-gradientAngle', '45');
  expect((await rectangle(page)).gradientAngle).toBe(45);
  await expect(page.getByTestId('gradient-arrow')).toHaveAttribute('style', /rotate\(45deg\)/);
  await page.getByTestId('prop-fillMode').selectOption('solid');
  expect((await rectangle(page)).fillMode).toBe('solid');
  await expect(page.getByTestId('prop-gradientTo')).toHaveCount(0);
});

test('Typography: gradient fill starts "To" from a contrasting shade; the outline colour shows once there is an outline', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-text').click();
  // White text, "To" also white: switching to Gradient sets To = white mixed 45 % toward black, in one step.
  const h = await past(page);
  await page.getByTestId('prop-fillMode').selectOption('linear');
  expect(await past(page)).toBe(h + 1);
  expect(await layerOf(page, 'Text')).toMatchObject({ fillMode: 'linear', color: '#ffffff', gradientTo: '#8c8c8c' });
  await expect(page.getByTestId('prop-gradientTo').locator('xpath=..').locator('input[type="text"]')).toHaveValue('#8c8c8c');

  await expect(page.getByTestId('prop-stroke')).toHaveCount(0);
  await expect(page.locator('.row', { has: page.getByTestId('prop-strokeWidth') })).toHaveAttribute('title', 'Outline around the letters, in pixels. 0 = no outline.');
  await setField(page, 'prop-strokeWidth', '12');
  expect(((await layerOf(page, 'Text')) as TextLayer).strokeWidth).toBe(12);
  await expect(page.getByTestId('prop-stroke')).toBeVisible();
});

/** Open "Animation presets" unless it already is (its open state survives switching between single layers). */
async function openPresets(page: Page) {
  const section = page.locator('details.section', { has: page.locator('summary', { hasText: 'Animation presets' }) });
  if ((await section.getAttribute('open')) === null) await section.locator('summary').click();
  await expect(section).toHaveAttribute('open');
}

test('"Draw on" preset: only for shapes; animates the outline 0 → 100 %; mixed selections skip the rest with a toast', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-text').click();
  await openPresets(page);
  const drawOn = page.getByTestId('preset-kind').locator('option[value="draw"]');
  await expect(drawOn).toHaveText('Draw on');
  await expect(drawOn).toBeDisabled();
  await expect(drawOn).toHaveAttribute('title', 'Select a shape to use Draw on');

  await page.getByTestId('add-rect').click();
  await openPresets(page);
  await expect(drawOn).toBeEnabled();
  await page.getByTestId('preset-kind').selectOption('draw');
  await expect(page.getByTestId('preset-direction')).toHaveCount(0);
  await page.getByTestId('preset-apply').click();
  const keys = (await rectangle(page)).keyframes.trimEnd;
  expect(keys.map((k) => [k.time, k.value, k.source])).toEqual([[0, 0, 'preset:in'], [0.6, 1, 'preset:in']]);
  // The rectangle has no outline yet: a toast says where to add one.
  await expect(page.locator('.toast', { hasText: 'Draw on animates the outline' })).toBeVisible();

  // Rectangle + text selected: applied to the shape, the text is skipped with a toast.
  await page.getByTestId('layer-item-Text').locator('.name').click({ modifiers: ['Shift'] });
  await expect(page.getByText('2 layers selected')).toBeVisible();
  await openPresets(page);
  await page.getByTestId('preset-kind').selectOption('draw');
  await page.getByTestId('preset-phase').selectOption('out');
  await page.getByTestId('preset-apply').click();
  await expect(page.locator('.toast', { hasText: "1 layer skipped: this effect isn't available on it." })).toBeVisible();
  expect((await rectangle(page)).keyframes.trimEnd.map((k) => k.value)).toEqual([0, 1, 1, 0]);
  expect(Object.keys((await layerOf(page, 'Text')).keyframes)).toEqual([]);
  expect((await getState(page)).project.scenes[0].layers).toHaveLength(2);
});
