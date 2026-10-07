// B3 "Make a copy in another format": fitToFrame maps the old frame into the new one (k = min(W2/W, H2/H), centred),
// so the frame centre lands on the new centre and every layer that was inside the frame stays inside.
import { describe, expect, it } from 'vitest';
import { aspectOf, fitToFrame, formatSize, type Format } from '../../src/shared/fitToFrame';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { applyMatrix, layerBox, layerMatrix, type Ctx2D } from '../../src/shared/renderFrame';
import { emptyProject, type Layer, type Project } from '../../src/shared/schema';

/** Text measuring without a canvas: 0.6 em per character. */
const fake = {
  font: '',
  save: () => undefined,
  restore: () => undefined,
  measureText: (text: string) => ({ width: text.length * 0.6 * Number(/(\d+(?:\.\d+)?)px/.exec(fake.font)?.[1] ?? 10) }),
};
const fakeCtx = fake as unknown as Ctx2D;

const base = { visible: true, locked: false, start: 0, duration: 3, anchorX: 0.5, anchorY: 0.5, rotation: 0, opacity: 1, keyframes: {} };

/** A 3840×2160 project whose layers all lie inside the frame, some touching its edges. */
function sample(): Project {
  return makeProject({
    ...emptyProject(),
    settings: { durationSec: 3, aspect: '16:9', width: 3840, height: 2160, fps: 30, background: '#000000' },
    scenes: [
      {
        id: 's', name: 'S', start: 0, duration: 3,
        layers: [
          makeLayer({ ...base, id: 'centre', name: 'Centre', type: 'shape', x: 1920, y: 1080, scale: 1, shape: 'rect', width: 400, height: 300, cornerRadius: 0, fill: '#fff', stroke: '#000', strokeWidth: 0 }),
          // Touches the top-left corner of the frame.
          makeLayer({ ...base, id: 'corner', name: 'Corner', type: 'shape', x: 300, y: 200, scale: 1.5, shape: 'ellipse', width: 400, height: 266.6666667, cornerRadius: 0, fill: '#fff', stroke: '#000', strokeWidth: 0 }),
          // Rotated, anchored at its top-left, animated in x, y and scale.
          makeLayer({
            ...base, id: 'moving', name: 'Moving', type: 'image', x: 2600, y: 1500, scale: 0.8, rotation: 30, anchorX: 0, anchorY: 0, assetId: 'img', width: 500, height: 300,
            keyframes: {
              x: [{ id: 'k1', time: 0, value: 2600, easing: { type: 'linear' } }, { id: 'k2', time: 2, value: 3000, easing: { type: 'linear' } }],
              y: [{ id: 'k3', time: 0, value: 1500, easing: { type: 'linear' } }, { id: 'k4', time: 2, value: 1600, easing: { type: 'linear' } }],
              scale: [{ id: 'k5', time: 0, value: 0.8, easing: { type: 'linear' } }, { id: 'k6', time: 2, value: 0.5, easing: { type: 'linear' } }],
              opacity: [{ id: 'k7', time: 0, value: 0.25, easing: { type: 'linear' } }, { id: 'k8', time: 2, value: 1, easing: { type: 'linear' } }],
            },
          }),
          makeLayer({ ...base, id: 'title', name: 'Title', type: 'text', x: 1920, y: 1900, scale: 1, content: 'Ship faster\nwith less', fontFamily: 'Inter', fontSize: 120, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center', color: '#fff' }),
          makeLayer({
            ...base, id: 'cursor', name: 'Cursor', type: 'cursor', x: 0, y: 0, scale: 1, anchorX: 0, anchorY: 0,
            points: [{ id: 'p1', x: 3800, y: 2100, time: 0 }, { id: 'p2', x: 1000, y: 700, time: 1 }],
            clicks: [{ id: 'c1', time: 1 }], smoothing: 0.5, size: 40, color: '#fff', rippleColor: '#fff6',
          }),
        ],
      },
    ],
  });
}

/** Corners of a layer's box at its keyframe-free state (static values). */
function corners(layer: Layer): [number, number][] {
  const box = layerBox(fakeCtx, layer);
  const m = layerMatrix(layer, box);
  return ([[0, 0], [box.w, 0], [box.w, box.h], [0, box.h]] as const).map(([x, y]) => applyMatrix(m, x, y));
}

const FORMATS: Format[] = ['9:16', '1:1', '4:5', '16:9'];
const EPS = 1e-5;

describe('formatSize', () => {
  it('keeps the long edge, like the Aspect setting', () => {
    const uhd = { width: 3840, height: 2160 };
    expect(FORMATS.map((f) => formatSize(uhd, f))).toEqual([
      { width: 2160, height: 3840 },
      { width: 3840, height: 3840 },
      { width: 3072, height: 3840 },
      { width: 3840, height: 2160 },
    ]);
    expect(formatSize({ width: 1080, height: 1920 }, '16:9')).toEqual({ width: 1920, height: 1080 });
    expect(formatSize({ width: 1366, height: 768 }, '9:16')).toEqual({ width: 768, height: 1366 });
    expect(aspectOf(768, 1366)).toBe('9:16');
    expect(aspectOf(1000, 700)).toBe('custom');
  });
});

describe('fitToFrame', () => {
  for (const f of FORMATS) {
    const { width: W2, height: H2 } = formatSize({ width: 3840, height: 2160 }, f);

    it(`${f}: the frame centre maps to the new centre and the settings change`, () => {
      const copy = fitToFrame(sample(), W2, H2);
      const centre = copy.scenes[0].layers.find((l) => l.id === 'centre')!;
      expect([centre.x, centre.y]).toEqual([W2 / 2, H2 / 2]);
      expect(copy.settings).toMatchObject({ width: W2, height: H2, aspect: f });
    });

    it(`${f}: every layer box stays inside the new frame (same map as the frame itself)`, () => {
      const p = sample();
      const k = Math.min(W2 / 3840, H2 / 2160);
      const copy = fitToFrame(p, W2, H2);
      copy.scenes[0].layers.forEach((layer, i) => {
        const before = p.scenes[0].layers[i];
        if (layer.type === 'cursor') {
          layer.points.forEach((pt, j) => {
            expect(pt.x).toBeCloseTo(W2 / 2 + k * (before.type === 'cursor' ? before.points[j].x - 1920 : 0), 6);
            expect(pt.x).toBeGreaterThanOrEqual(-EPS);
            expect(pt.x).toBeLessThanOrEqual(W2 + EPS);
            expect(pt.y).toBeGreaterThanOrEqual(-EPS);
            expect(pt.y).toBeLessThanOrEqual(H2 + EPS);
          });
          expect(layer.scale).toBeCloseTo(k, 9);
          return;
        }
        const old = corners(before);
        corners(layer).forEach(([x, y], j) => {
          // Exactly the frame's map applied to the old corner…
          expect(x).toBeCloseTo(W2 / 2 + k * (old[j][0] - 1920), 4);
          expect(y).toBeCloseTo(H2 / 2 + k * (old[j][1] - 1080), 4);
          // …so it stays inside the new frame.
          expect(x).toBeGreaterThanOrEqual(-EPS);
          expect(x).toBeLessThanOrEqual(W2 + EPS);
          expect(y).toBeGreaterThanOrEqual(-EPS);
          expect(y).toBeLessThanOrEqual(H2 + EPS);
        });
      });
    });
  }

  it('maps x/y/scale keyframes and leaves other properties alone; the original is untouched', () => {
    const p = Object.freeze(sample()) as Project;
    const before = JSON.stringify(p);
    const copy = fitToFrame(p, 2160, 3840);
    const k = 0.5625;
    const m = copy.scenes[0].layers.find((l) => l.id === 'moving')!;
    expect(m.keyframes.x.map((kf) => kf.value)).toEqual([1080 + k * (2600 - 1920), 1080 + k * (3000 - 1920)]);
    expect(m.keyframes.y.map((kf) => kf.value)).toEqual([1920 + k * (1500 - 1080), 1920 + k * (1600 - 1080)]);
    expect(m.keyframes.scale.map((kf) => kf.value)).toEqual([0.45, 0.28125]);
    expect(m.keyframes.opacity.map((kf) => kf.value)).toEqual([0.25, 1]);
    expect(m).toMatchObject({ rotation: 30, anchorX: 0, anchorY: 0, width: 500, height: 300 });
    const title = copy.scenes[0].layers.find((l) => l.id === 'title')!;
    expect(title).toMatchObject({ fontSize: 120, scale: k });
    expect(JSON.stringify(p)).toBe(before);
  });

  it('a vertical project made landscape shrinks to fit the height', () => {
    const p = fitToFrame(sample(), 2160, 3840);
    const back = fitToFrame(p, 3840, 2160);
    const c = back.scenes[0].layers.find((l) => l.id === 'centre')!;
    expect([c.x, c.y]).toEqual([1920, 1080]);
    expect(c.scale).toBeCloseTo(0.5625 * 0.5625, 9);
  });
});
