// inkBounds (A1): every coordinate drawLayer paints lies inside the box, for every layer type, at several times,
// render scales and transforms. The cursor is drawn at cursorPosition, not in its layer box.
import { describe, expect, it } from 'vitest';
import { makeLayer } from '../../src/shared/factories';
import { cursorPosition } from '../../src/shared/geometry';
import { inkBounds } from '../../src/shared/inkBounds';
import { drawLayer } from '../../src/shared/renderFrame';
import type { Layer, LayerInput } from '../../src/shared/schema';
import { drawnPoints, recordingCtx } from './helpers/recordingCtx';

const base = { visible: true, locked: false, start: 0, duration: 4, anchorX: 0.5, anchorY: 0.5, x: 900, y: 500, scale: 1, rotation: 0, opacity: 1, keyframes: {} };
const L = (input: Partial<LayerInput> & { type: LayerInput['type'] }) => makeLayer({ ...base, id: 'l', name: 'L', ...input } as LayerInput);

const text = (over: object = {}) =>
  L({ type: 'text', content: 'Hello\nWide second line\nx', fontFamily: 'Inter', fontSize: 80, fontWeight: 700, lineHeight: 1.2, letterSpacing: 2, align: 'center', color: '#fff', ...over });
const shape = (over: object = {}) =>
  L({ type: 'shape', shape: 'rect', width: 300, height: 180, cornerRadius: 24, fill: '#f00', stroke: '#fff', strokeWidth: 16, ...over });
const image = (over: object = {}) => L({ type: 'image', assetId: 'missing', width: 320, height: 240, ...over });
const cursor = (over: object = {}) =>
  L({
    type: 'cursor', x: 0, y: 0, anchorX: 0, anchorY: 0,
    points: [{ id: 'a', x: 1200, y: 700, time: 0 }, { id: 'b', x: 1500, y: 300, time: 1 }, { id: 'c', x: 600, y: 900, time: 2 }],
    clicks: [{ id: 'k', time: 1 }], smoothing: 1, size: 60, color: '#ffffff', rippleColor: '#ffffff66', ...over,
  });

const IMAGES = new Map<string, CanvasImageSource>([['loaded', { name: 'img', width: 10, height: 10 } as unknown as CanvasImageSource]]);

/** Draw `layer` plainly at render scale `scale` and return the ink box and every painted point. */
function check(layer: Layer, local: number, scale: number) {
  const rec = recordingCtx(4000, 3000);
  const ink = inkBounds(layer, local, scale, rec.ctx);
  rec.reset();
  rec.ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawLayer(rec.ctx, layer, local, { images: IMAGES }, scale);
  const pts = drawnPoints(rec.log);
  const outside = pts.filter((p) => p.x < ink.x0 - 1e-6 || p.x > ink.x1 + 1e-6 || p.y < ink.y0 - 1e-6 || p.y > ink.y1 + 1e-6);
  return { ink, pts, outside };
}

const cases: [string, Layer][] = [
  ['multi-line centred text', text()],
  ['right-aligned rotated, scaled text', text({ align: 'right', rotation: 33, scale: 1.7, anchorX: 0, anchorY: 1 })],
  ['left-aligned text, negative scale', text({ align: 'left', scale: -0.8, rotation: -100 })],
  ['text with outline width', text({ strokeWidth: 12 })],
  ['rounded rect with a thick outline, rotated', shape({ rotation: 45 })],
  ['sharp rect (miter corners), mirrored', shape({ cornerRadius: 0, scale: -1.3, rotation: 10 })],
  ['ellipse with outline', shape({ shape: 'ellipse', rotation: 70, anchorX: 0.2 })],
  ['rect without outline', shape({ strokeWidth: 0, anchorX: 1, anchorY: 0 })],
  ['missing image placeholder, rotated', image({ rotation: 27, scale: 0.6 })],
  ['loaded image', image({ assetId: 'loaded', rotation: -15 })],
  ['cursor', cursor()],
  ['cursor, mirrored scale', cursor({ scale: -1.5 })],
];

describe('inkBounds contains everything drawLayer paints', () => {
  for (const [name, layer] of cases) {
    it(name, () => {
      for (const scale of [1, 0.37, 2])
        for (const local of [0, 0.4, 1, 1.07, 1.3, 2.5]) {
          const { pts, outside } = check(layer, local, scale);
          expect(pts.length).toBeGreaterThan(0);
          expect(outside, `${name} at t=${local}, scale ${scale}`).toEqual([]);
        }
    });
  }
});

describe('inkBounds is tight enough to be useful', () => {
  it('a 300×180 rect with a 16 px outline at scale 1 is its box ± half the outline (+2 px antialiasing)', () => {
    const { ink } = check(shape({ x: 500, y: 400 }), 0, 1);
    expect(ink).toEqual({ x0: 500 - 150 - 8 - 2, y0: 400 - 90 - 8 - 2, x1: 500 + 150 + 8 + 2, y1: 400 + 90 + 8 + 2 });
  });

  it('render scale multiplies the box', () => {
    const a = check(shape({ x: 500, y: 400, strokeWidth: 0 }), 0, 1).ink;
    const b = check(shape({ x: 500, y: 400, strokeWidth: 0 }), 0, 0.5).ink;
    expect(b.x1 - b.x0).toBeCloseTo((a.x1 - a.x0 - 4) / 2 + 4, 0);
  });

  it('the cursor box follows cursorPosition, not the layer box at (x, y)', () => {
    const c = cursor();
    for (const t of [0, 1.5, 2]) {
      const { ink } = check(c, t, 1);
      const pos = cursorPosition(c as Extract<Layer, { type: 'cursor' }>, t);
      expect(ink.x0).toBeLessThanOrEqual(pos.x);
      expect(ink.x1).toBeGreaterThan(pos.x + 40);
      expect(ink.y1).toBeGreaterThan(pos.y + 60);
      // Nowhere near the layer's own x/y (0, 0).
      expect(ink.x0).toBeGreaterThan(400);
    }
  });

  it('the cursor box grows with an active click ripple (r ≤ 1.5 × size × scale)', () => {
    const c = cursor();
    const idle = check(c, 0.5, 1).ink;
    const ripple = check(c, 1.4, 1).ink;
    const pos = cursorPosition(c as Extract<Layer, { type: 'cursor' }>, 1.4);
    expect(ripple.x0).toBeLessThan(pos.x - 60);
    expect(ripple.x0).toBeGreaterThanOrEqual(Math.floor(pos.x - 1.5 * 60) - 3);
    expect(idle.x1 - idle.x0).toBeLessThan(ripple.x1 - ripple.x0);
  });

  it('text animators widen the box by their travel distance and blur', () => {
    const anim = { unit: 'word', order: 'forward', stagger: 0.1, duration: 0.5, delay: 0, easing: { type: 'easeOut' }, seed: 1, caret: false } as const;
    const plain = check(text(), 0, 1).ink;
    const rise = check(text({ textIn: { ...anim, effect: 'rise', distance: 40 } }), 0, 1).ink;
    const blur = check(text({ textIn: { ...anim, effect: 'blur', distance: 10 } }), 0, 1).ink;
    expect(rise.y0).toBe(plain.y0 - 40);
    expect(rise.y1).toBe(plain.y1 + 40);
    expect(blur.x0).toBe(plain.x0 - 30);
  });

  it('empty text has an empty box', () => {
    const { ink } = check(text({ content: ' \n ' }), 0, 1);
    expect(ink.x1 <= ink.x0 || ink.y1 <= ink.y0).toBe(true);
  });
});
