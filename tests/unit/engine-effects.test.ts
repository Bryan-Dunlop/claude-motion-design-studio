// A1 layer effects in Node: resolved values (incl. the layer-scale factor k), clamping, and the draw calls renderFrame
// makes (direct vs isolated, clipped filters, scratch canvases). Pixel checks live in tests/e2e/engine-effects.spec.ts.
import { describe, expect, it } from 'vitest';
import { blurMargin, clampResolved, effectRegion, layerEffects, shadowDefaults, shadowMargin } from '../../src/shared/effects';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { inkBounds } from '../../src/shared/inkBounds';
import { resolveLayer } from '../../src/shared/interpolate';
import { drawLayer, renderFrame } from '../../src/shared/renderFrame';
import type { Layer, LayerInput, Project } from '../../src/shared/schema';
import { allRecorders, parseEntry, recordingCtx, unclippedFilteredDraws, type Recorder } from './helpers/recordingCtx';

const base = { visible: true, locked: false, start: 0, duration: 4, anchorX: 0.5, anchorY: 0.5, x: 800, y: 450, scale: 1, rotation: 0, opacity: 1, keyframes: {} };
const L = (input: Partial<LayerInput> & { type: LayerInput['type'] }) => makeLayer({ ...base, id: 'l', name: 'L', ...input } as LayerInput);
const rect = (over: object = {}) => L({ type: 'shape', shape: 'rect', width: 200, height: 100, cornerRadius: 0, fill: '#4f7cff', stroke: '#ffcc00', strokeWidth: 0, ...over });
const text = (over: object = {}) =>
  L({ type: 'text', content: 'Hello', fontFamily: 'Inter', fontSize: 60, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center', color: '#fff', ...over });
const cursor = (over: object = {}) =>
  L({
    type: 'cursor', x: 0, y: 0, anchorX: 0, anchorY: 0, points: [{ id: 'a', x: 1200, y: 700, time: 0 }], clicks: [], smoothing: 0, size: 40,
    color: '#ffffff', rippleColor: '#ffffff66', shadow: true, shadowColor: '#00000059', shadowBlur: 6, shadowOffsetY: 3, ...over,
  });
const SHADOW = { shadow: true, shadowColor: '#000000cc', shadowBlur: 0, shadowOffsetX: 20, shadowOffsetY: 20 };

function project(layers: Layer[], extra: Partial<Project> = {}): Project {
  return makeProject({
    schemaVersion: 2,
    settings: { durationSec: 4, aspect: '16:9', width: 1600, height: 900, fps: 30, background: '#e0e0e0' },
    assets: [],
    scenes: [{ id: 's', name: 'S', start: 0, duration: 4, layers }],
    ...extra,
  });
}

/** Render one layer with a recording pool; returns the main recorder. */
function render(layer: Layer, scale = 1, t = 0.5, images = new Map<string, CanvasImageSource>()) {
  const rec = recordingCtx(1600 * scale, 900 * scale);
  renderFrame(project([layer]), t, rec.ctx, scale, { images, canvasPool: rec.pool });
  return rec;
}

const has = (log: string[], prefix: string) => log.some((l) => l.startsWith(prefix));
const EFFECT_STATE = ['shadowColor=', 'shadowBlur=', 'shadowOffsetX=', 'shadowOffsetY=', 'filter=', 'globalCompositeOperation='];

describe('effect values', () => {
  it('blur, shadow blur and shadow offsets scale with k = render scale × |layer scale|', () => {
    const l = rect({ scale: -2, blur: 3, shadow: true, shadowBlur: 10, shadowOffsetX: 4, shadowOffsetY: -6 });
    expect(layerEffects(l, 0.5)).toMatchObject({ blur: 3, shadow: { blur: 10, offsetX: 4, offsetY: -6 } }); // k = 1
    expect(layerEffects(l, 1.5)).toMatchObject({ blur: 9, shadow: { blur: 30, offsetX: 12, offsetY: -18 } }); // k = 3
    // The cursor uses its own scale too.
    expect(layerEffects(cursor({ scale: 0.5, blur: 4 }), 1)).toMatchObject({ blur: 2, shadow: { blur: 3, offsetY: 1.5 } });
  });

  it('shadow offsets stay screen-space: rotating the layer does not turn them', () => {
    const fx = layerEffects(rect({ ...SHADOW, rotation: 90 }), 1);
    expect(fx.shadow).toMatchObject({ offsetX: 20, offsetY: 20 });
    const rec = render(rect({ ...SHADOW, rotation: 90 }));
    expect(rec.log).toContain('shadowOffsetX=20');
    expect(rec.log).toContain('shadowOffsetY=20');
  });

  it('a shadow is drawn only when switched on and its colour is visible', () => {
    expect(layerEffects(rect({ ...SHADOW, shadow: false }), 1).shadow).toBeNull();
    expect(layerEffects(rect({ ...SHADOW, shadowColor: '#00000000' }), 1).shadow).toBeNull();
    expect(layerEffects(rect({ ...SHADOW, shadowOffsetX: 0, shadowOffsetY: 0 }), 1).active).toBe(false);
    expect(has(render(rect({ ...SHADOW, shadow: false })).log, 'shadowColor=')).toBe(false);
    expect(layerEffects(rect(SHADOW), 1).shadow).toEqual({ color: '#000000cc', blur: 0, offsetX: 20, offsetY: 20 });
  });

  it('blend modes map to globalCompositeOperation; normal stays source-over (no assignment)', () => {
    expect(layerEffects(rect(), 1)).toMatchObject({ composite: 'source-over', active: false });
    expect(layerEffects(rect({ blendMode: 'multiply' }), 1)).toMatchObject({ composite: 'multiply', active: true });
    expect(render(rect({ blendMode: 'color-dodge' })).log).toContain('globalCompositeOperation="color-dodge"');
    // Only renderFrame's own reset to source-over appears for a normal layer.
    expect(render(rect()).log.filter((l) => l.startsWith('globalCompositeOperation='))).toEqual(['globalCompositeOperation="source-over"']);
  });

  it('clamps overshooting animated values before they reach the canvas', () => {
    const spring = { type: 'spring', stiffness: 400, damping: 3, mass: 1 } as const;
    const l = rect({
      strokeWidth: 4,
      keyframes: {
        blur: [{ id: 'a', time: 0, value: 8, easing: spring }, { id: 'b', time: 2, value: 0, easing: { type: 'linear' } }],
        shadowBlur: [{ id: 'c', time: 0, value: 8, easing: spring }, { id: 'd', time: 2, value: 0, easing: { type: 'linear' } }],
        strokeWidth: [{ id: 'e', time: 0, value: 6, easing: spring }, { id: 'f', time: 2, value: 0, easing: { type: 'linear' } }],
        opacity: [{ id: 'g', time: 0, value: 0, easing: spring }, { id: 'h', time: 2, value: 1, easing: { type: 'linear' } }],
      },
    });
    // Find a time where the spring has overshot below 0 / above 1.
    const t = [...Array(200)].map((_, i) => i / 100).find((x) => (resolveLayer(l, x) as Layer & { blur: number }).blur < -0.5)!;
    expect(t).toBeDefined();
    const raw = resolveLayer(l, t) as Extract<Layer, { type: 'shape' }>;
    expect(raw.opacity).toBeGreaterThan(1);
    expect(raw.strokeWidth).toBeLessThan(0);
    const c = clampResolved(raw);
    expect([c.blur, c.shadowBlur, c.strokeWidth, c.opacity]).toEqual([0, 0, 0, 1]);
    const rec = render(l, 1, t);
    expect(rec.log.filter((x) => /^(filter|shadowBlur|lineWidth)=/.test(x))).toEqual([]);
    expect(rec.log).toContain('globalAlpha=1');
    // Unchanged layers are returned as is (no copy).
    const plain = rect();
    expect(clampResolved(plain)).toBe(plain);
  });

  it('margins: a blur of radius r spreads 3r, a shadow blur b spreads 1.5b', () => {
    expect([blurMargin(0), blurMargin(4), blurMargin(4.1)]).toEqual([0, 12, 13]);
    expect([shadowMargin(0), shadowMargin(10), shadowMargin(11)]).toEqual([0, 15, 17]);
    const fx = layerEffects(rect({ blur: 2, shadow: true, shadowBlur: 4, shadowOffsetY: 30 }), 1);
    expect(effectRegion({ x0: 0, y0: 0, x1: 100, y1: 50 }, fx)).toEqual({ x0: -6 - 6, y0: -6, x1: 106 + 6, y1: 56 + 30 + 6 });
  });

  it('drop-shadow defaults are sized from the short edge of the frame', () => {
    expect(shadowDefaults({ width: 3840, height: 2160 })).toEqual({ shadowColor: '#00000040', shadowOffsetY: 16, shadowBlur: 48 });
    expect(shadowDefaults({ width: 1080, height: 1920 })).toEqual({ shadowColor: '#00000040', shadowOffsetY: 8, shadowBlur: 24 });
  });
});

describe('effect drawing', () => {
  it('single-draw layer: the effect goes on its one draw call; a filtered draw is clipped to ink ⊕ 3·radius', () => {
    const l = rect({ blur: 4, scale: 2 });
    const rec = render(l, 0.5); // k = 1
    expect(rec.children).toHaveLength(0);
    const ink = inkBounds(l, 0.5, 0.5, recordingCtx().ctx);
    const clip = effectRegion(ink, layerEffects(l, 0.5));
    // 200×100 box at scale 2 × 0.5 = 200×100 canvas px, + 2 px antialiasing + 12 px blur margin on each side.
    expect([clip.x1 - clip.x0, clip.y1 - clip.y0]).toEqual([200 + 28, 100 + 28]);
    const i = rec.log.indexOf(`rect([${clip.x0},${clip.y0},${clip.x1 - clip.x0},${clip.y1 - clip.y0}])`);
    expect(i).toBeGreaterThan(0);
    expect(rec.log.slice(i + 1, i + 3)).toEqual(['clip([])', 'setTransform([0.5,0,0,0.5,0,0])']);
    expect(rec.log.indexOf('filter="blur(4px)"')).toBeGreaterThan(i);
    expect(unclippedFilteredDraws(rec.log)).toEqual([]);
  });

  it('multi-draw layers are isolated: drawn plainly into a scratch canvas, composited once with the effect', () => {
    const rec = render(rect({ ...SHADOW, strokeWidth: 8 }));
    expect(rec.children).toHaveLength(1);
    const scratch = rec.children[0];
    // Plain drawing in the scratch: no effect state, no opacity.
    expect(scratch.log.filter((l) => EFFECT_STATE.some((p) => l.startsWith(p)) || l.startsWith('globalAlpha='))).toEqual([]);
    expect(scratch.log).toContain('fill([])');
    expect(scratch.log).toContain('stroke([])');
    // One composite on the main canvas, at identity, with the shadow.
    const draw = rec.log.findIndex((l) => l.startsWith('drawImage(["<canvas main.0>"'));
    expect(draw).toBeGreaterThan(0);
    const before = rec.log.slice(0, draw);
    expect(before.lastIndexOf('setTransform([1,0,0,1,0,0])')).toBeGreaterThan(before.lastIndexOf('save([])'));
    expect(before).toContain('shadowColor="#000000cc"');
    expect(before).toContain('shadowOffsetX=20');
    const [, x, y] = (parseEntry(rec.log[draw]) as { args: number[] }).args;
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    // The scratch is positioned so the layer lands where it would have been drawn directly.
    expect(scratch.log[0]).toBe(`setTransform([1,0,0,1,${-x},${-y}])`);
    // Fill and stroke happen once each (not per shadow).
    expect(rec.log.filter((l) => l === 'fill([])' || l === 'stroke([])')).toEqual([]);
  });

  it('single-draw layers keep the direct path; multi-draw ones are isolated only when an effect is active', () => {
    const missing = L({ type: 'image', assetId: 'nope', width: 100, height: 80, blendMode: 'multiply' });
    const loaded = L({ type: 'image', assetId: 'img', width: 100, height: 80, blendMode: 'multiply' });
    const images = new Map<string, CanvasImageSource>([['img', { name: 'img', width: 1, height: 1 } as unknown as CanvasImageSource]]);
    expect(render(missing, 1, 0.5, images).children).toHaveLength(1);
    expect(render(loaded, 1, 0.5, images).children).toHaveLength(0);
    expect(render(text({ ...SHADOW, content: 'One line' })).children).toHaveLength(0);
    expect(render(text({ ...SHADOW, content: 'Two\nlines' })).children).toHaveLength(1);
    expect(render(rect({ ...SHADOW })).children).toHaveLength(0);
    expect(render(rect({ strokeWidth: 8 })).children).toHaveLength(0); // no effect → v1 path
    expect(render(cursor({ shadow: false })).children).toHaveLength(0);
    expect(render(cursor()).children).toHaveLength(1);
  });

  it('the cursor scratch canvas sits at the pointer (cursorPosition), not at the layer box', () => {
    const rec = render(cursor(), 0.5);
    const draw = rec.log.find((l) => l.startsWith('drawImage(["<canvas main.0>"'))!;
    const [, x, y] = (parseEntry(draw) as { args: number[] }).args;
    // Pointer tip at (1200, 700) × 0.5; the box starts a few px up/left of it (outline + antialiasing).
    expect(x).toBeGreaterThan(590);
    expect(x).toBeLessThanOrEqual(600);
    expect(y).toBeGreaterThan(340);
    expect(y).toBeLessThanOrEqual(350);
    expect(rec.children[0].log).toContain('fill([])');
  });

  it('opacity is applied once, at the composite', () => {
    const rec = render(rect({ ...SHADOW, strokeWidth: 8, opacity: 0.4 }));
    const draw = rec.log.findIndex((l) => l.startsWith('drawImage(["<canvas main.0>"'));
    expect(rec.log.slice(0, draw)).toContain('globalAlpha=0.4');
    expect(rec.children[0].log.some((l) => l.startsWith('globalAlpha='))).toBe(false);
  });

  it('every filtered draw is clipped, and scratch canvases are released once per frame', () => {
    const layers = [
      rect({ blur: 6 }),
      rect({ blur: 3, strokeWidth: 10, ...SHADOW }),
      text({ blur: 2, content: 'Multi\nline', blendMode: 'screen' }),
      text({ blur: 5 }),
      cursor({ blur: 1 }),
      L({ type: 'image', assetId: 'nope', width: 100, height: 80, blur: 4 }),
    ];
    const rec = recordingCtx(1600, 900);
    renderFrame(project(layers), 0.5, rec.ctx, 1, { images: new Map(), canvasPool: rec.pool });
    for (const r of allRecorders(rec)) expect(unclippedFilteredDraws(r.log)).toEqual([]);
    expect(rec.log.filter((l) => l.startsWith('filter=')).length).toBe(6);
    expect(rec.releases()).toBe(1);
    expect(rec.children).toHaveLength(4);
  });

  it('without a pool, scratch canvases come from resources.createCanvas', () => {
    const rec = recordingCtx(1600, 900);
    renderFrame(project([cursor()]), 0.5, rec.ctx, 1, { images: new Map(), createCanvas: rec.createCanvas });
    expect(rec.children).toHaveLength(1);
    expect(rec.releases()).toBe(0);
  });

  it('an isolated layer that cannot reach the frame is skipped; a shadow cast into the frame is still drawn', () => {
    const off = (over: object) => rect({ ...SHADOW, strokeWidth: 8, x: -500, ...over });
    const gone = render(off({}));
    expect(gone.children).toHaveLength(0);
    expect(gone.log.some((l) => l.startsWith('drawImage'))).toBe(false);
    // Shadow offset 600 px brings the shadow of an off-frame layer into view.
    const cast = render(off({ shadowOffsetX: 600 }));
    expect(cast.children).toHaveLength(1);
    expect(cast.log.some((l) => l.startsWith('drawImage(["<canvas main.0>"'))).toBe(true);
  });

  it('drawLayer: the effect factor uses the scale it is given (zoomed views scale effects too)', () => {
    const rec = recordingCtx(1600, 900);
    rec.ctx.setTransform(2.5, 0, 0, 2.5, 0, 0);
    drawLayer(rec.ctx, rect({ blur: 2 }), 0, { images: new Map() }, 2.5);
    expect(rec.log).toContain('filter="blur(5px)"');
  });

  it('is deterministic, also through scratch canvases', () => {
    const l = [rect({ ...SHADOW, strokeWidth: 8, blur: 2 }), cursor(), text({ content: 'A\nB', blendMode: 'multiply' })];
    const logs = (r: Recorder) => allRecorders(r).map((x) => x.log);
    const a = recordingCtx(1600, 900);
    const b = recordingCtx(1600, 900);
    renderFrame(project(l), 1.2, a.ctx, 0.75, { images: new Map(), canvasPool: a.pool });
    renderFrame(project(l), 3, recordingCtx().ctx, 1, { images: new Map(), createCanvas: recordingCtx().createCanvas });
    renderFrame(project(l), 1.2, b.ctx, 0.75, { images: new Map(), canvasPool: b.pool });
    expect(logs(b)).toEqual(logs(a));
  });
});
