// A3 shapes v2 in Node: outline paths (start points, direction), exact lengths vs numeric integration of the path that
// is actually traced, trim dash maths, gradient endpoints and the "To" colour rule, the "Draw on" preset, and the draw
// calls renderFrame makes (trim, gradients, text outline before fill). Pixel checks live in tests/e2e/engine-shapes.spec.ts.
import { describe, expect, it } from 'vitest';
import { makeLayer } from '../../src/shared/factories';
import { inkBounds } from '../../src/shared/inkBounds';
import { applyPreset, presetApplies, presetProps, type PresetParams } from '../../src/shared/presets';
import { drawLayer, drawTextUnits } from '../../src/shared/renderFrame';
import type { Layer, LayerInput, ShapeLayer, TextLayer } from '../../src/shared/schema';
import {
  clampedRadius,
  ellipsePerimeter,
  gradientLine,
  gradientToFor,
  luminance,
  mixColor,
  shapeLength,
  shapeTrim,
  shapeVertices,
  traceShape,
  trimStroke,
  type PathSink,
  type ShapeGeometry,
} from '../../src/shared/shapes';
import { drawnPoints, parseEntry, recordingCtx } from './helpers/recordingCtx';

const base = { visible: true, locked: false, start: 0, duration: 4, anchorX: 0.5, anchorY: 0.5, x: 900, y: 500, scale: 1, rotation: 0, opacity: 1, keyframes: {} };
const L = (input: Partial<LayerInput> & { type: LayerInput['type'] }) => makeLayer({ ...base, id: 'l', name: 'L', ...input } as LayerInput);
const shape = (over: Partial<ShapeLayer> = {}) =>
  L({ type: 'shape', shape: 'rect', width: 300, height: 180, cornerRadius: 0, fill: '#4f7cff', stroke: '#ffffff', strokeWidth: 0, ...over } as LayerInput) as ShapeLayer;
const text = (over: Partial<TextLayer> = {}) =>
  L({ type: 'text', content: 'Hello\nWorld', fontFamily: 'Inter', fontSize: 80, fontWeight: 700, lineHeight: 1.25, letterSpacing: 0, align: 'left', color: '#ffffff', ...over } as LayerInput) as TextLayer;
const geo = (over: Partial<ShapeGeometry>): ShapeGeometry => ({ shape: 'rect', width: 300, height: 180, cornerRadius: 0, points: 5, innerRadius: 0.45, ...over });

// ---------------------------------------------------------------- flattening the traced path (independent of shapes.ts maths)

type P = [number, number];

/**
 * Replay traceShape on a path sink that follows the canvas rules for moveTo / lineTo / arcTo / ellipse / closePath and
 * flattens every arc into tiny segments. Returns the polyline (one subpath) in drawing order.
 */
function trace(g: ShapeGeometry, outline = true, steps = 4000): P[] {
  const pts: P[] = [];
  let start: P | null = null;
  const cur = () => pts[pts.length - 1];
  const sink: PathSink = {
    beginPath: () => void (pts.length = 0),
    moveTo: (x, y) => {
      pts.push([x, y]);
      start = [x, y];
    },
    lineTo: (x, y) => void pts.push([x, y]),
    closePath: () => void (start && pts.push([...start])),
    arcTo: (x1, y1, x2, y2, r) => {
      const [x0, y0] = cur();
      const u = [x0 - x1, y0 - y1];
      const v = [x2 - x1, y2 - y1];
      const lu = Math.hypot(u[0], u[1]);
      const lv = Math.hypot(v[0], v[1]);
      const cross = u[0] * v[1] - u[1] * v[0];
      // Canvas: a zero radius, coincident points or collinear points just add a straight line to (x1, y1).
      if (r === 0 || lu < 1e-12 || lv < 1e-12 || Math.abs(cross) < 1e-12) return void pts.push([x1, y1]);
      const [ux, uy] = [u[0] / lu, u[1] / lu];
      const [vx, vy] = [v[0] / lv, v[1] / lv];
      const theta = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
      const d = r / Math.tan(theta / 2);
      const t1: P = [x1 + ux * d, y1 + uy * d];
      const t2: P = [x1 + vx * d, y1 + vy * d];
      const bis = [ux + vx, uy + vy];
      const lb = Math.hypot(bis[0], bis[1]);
      const c: P = [x1 + (bis[0] / lb) * (r / Math.sin(theta / 2)), y1 + (bis[1] / lb) * (r / Math.sin(theta / 2))];
      pts.push(t1);
      const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
      let sweep = Math.atan2(t2[1] - c[1], t2[0] - c[0]) - a1;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      for (let i = 1; i <= steps; i++) pts.push([c[0] + r * Math.cos(a1 + (sweep * i) / steps), c[1] + r * Math.sin(a1 + (sweep * i) / steps)]);
    },
    ellipse: (cx, cy, rx, ry, rot, a0, a1, ccw) => {
      expect(rot).toBe(0);
      expect(ccw ?? false).toBe(false);
      const n = steps * 4;
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        const p: P = [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
        if (i === 0 && !pts.length) start = p;
        pts.push(p);
      }
    },
  };
  traceShape(sink, g, outline);
  return pts;
}

const polylineLength = (pts: P[]) => pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
/** Shoelace sum: > 0 means clockwise on screen (y down). */
const signedArea = (pts: P[]) => pts.reduce((sum, p, i) => (i ? sum + (pts[i - 1][0] * p[1] - p[0] * pts[i - 1][1]) : sum), 0) / 2;

// ---------------------------------------------------------------- paths & lengths

describe('outline paths', () => {
  it('rect starts on the top edge just after the top-left corner radius and runs clockwise', () => {
    for (const g of [geo({ cornerRadius: 24 }), geo({ cornerRadius: 0 }), geo({ width: 400, height: 120, cornerRadius: 500 })]) {
      const pts = trace(g);
      expect(pts[0]).toEqual([clampedRadius(g), 0]);
      expect(pts[1][0]).toBeGreaterThan(pts[0][0]); // heading right along the top edge
      expect(signedArea(pts)).toBeGreaterThan(0);
    }
  });

  it('a trimmed ellipse starts at 12 o’clock and runs clockwise; an untrimmed one keeps the v1 call', () => {
    const g = geo({ shape: 'ellipse', width: 200, height: 120 });
    const pts = trace(g, true);
    expect(pts[0][0]).toBeCloseTo(100, 9);
    expect(pts[0][1]).toBeCloseTo(0, 9);
    expect(pts[1][0]).toBeGreaterThan(100); // clockwise on screen: from the top towards the right
    expect(pts[1][1]).toBeGreaterThan(0);
    expect(signedArea(pts)).toBeGreaterThan(0);
    const last = pts[pts.length - 1];
    expect(last[0]).toBeCloseTo(100, 9); // closed back at 12 o'clock
    expect(last[1]).toBeCloseTo(0, 9);
    // The exact calls: trimmed from −π/2 and closed; untrimmed exactly like v1 (0 → 2π, not closed).
    const rec = recordingCtx();
    traceShape(rec.ctx, g, true);
    expect(rec.log).toEqual(['beginPath([])', `ellipse([100,60,100,60,0,${-Math.PI / 2},${(3 * Math.PI) / 2}])`, 'closePath([])']);
    rec.reset();
    traceShape(rec.ctx, g, false);
    expect(rec.log).toEqual(['beginPath([])', `ellipse([100,60,100,60,0,0,${2 * Math.PI}])`]);
  });

  it('polygon, star and triangle start at vertex 0 at the top and run clockwise; the line starts at its left end', () => {
    for (const g of [geo({ shape: 'polygon', points: 6 }), geo({ shape: 'star', points: 5 }), geo({ shape: 'triangle' }), geo({ shape: 'polygon', points: 3, width: 100, height: 300 })]) {
      const pts = trace(g);
      expect(pts[0][0]).toBeCloseTo(g.width / 2, 9);
      expect(pts[0][1]).toBeCloseTo(0, 9);
      expect(pts[1][0]).toBeGreaterThan(g.width / 2);
      expect(signedArea(pts)).toBeGreaterThan(0);
    }
    expect(trace(geo({ shape: 'line', width: 300, height: 20 }))).toEqual([[0, 10], [300, 10]]);
  });

  it('vertices: triangle (w/2,0) (w,h) (0,h); polygon on the ellipse w/2 × h/2; star tips and inner corners at innerRadius × outer', () => {
    expect(shapeVertices(geo({ shape: 'triangle', width: 200, height: 100 }))).toEqual([[100, 0], [200, 100], [0, 100]]);
    const hex = shapeVertices(geo({ shape: 'polygon', points: 6, width: 200, height: 100 }));
    expect(hex).toHaveLength(6);
    for (const [x, y] of hex) expect(((x - 100) / 100) ** 2 + ((y - 50) / 50) ** 2).toBeCloseTo(1, 12);
    expect(hex[3][0]).toBeCloseTo(100, 9);
    expect(hex[3][1]).toBeCloseTo(100, 9); // opposite vertex at the bottom
    const star = shapeVertices(geo({ shape: 'star', points: 5, innerRadius: 0.4, width: 200, height: 200 }));
    expect(star).toHaveLength(10);
    star.forEach(([x, y], i) => expect(Math.hypot(x - 100, y - 100)).toBeCloseTo(i % 2 ? 40 : 100, 9));
    // Out-of-range sides are clamped to 3..64.
    expect(shapeVertices(geo({ shape: 'polygon', points: 2 }))).toHaveLength(3);
    expect(shapeVertices(geo({ shape: 'polygon', points: 100 }))).toHaveLength(64);
  });
});

describe('outline length = numeric integration of the traced path', () => {
  const cases: [string, ShapeGeometry, number][] = [
    ['sharp rect', geo({ cornerRadius: 0 }), 1e-9],
    ['rounded rect', geo({ cornerRadius: 24 }), 1e-6],
    ['pill: r > h/2 is clamped to h/2', geo({ width: 400, height: 120, cornerRadius: 500 }), 1e-6],
    ['upright pill: r > w/2 is clamped to w/2', geo({ width: 80, height: 300, cornerRadius: 999 }), 1e-6],
    ['rounded square that is a circle', geo({ width: 200, height: 200, cornerRadius: 100 }), 1e-6],
    ['ellipse 200×120', geo({ shape: 'ellipse', width: 200, height: 120 }), 1e-6],
    ['circle', geo({ shape: 'ellipse', width: 150, height: 150 }), 1e-6],
    ['flat ellipse 400×40', geo({ shape: 'ellipse', width: 400, height: 40 }), 1e-4],
    ['triangle', geo({ shape: 'triangle', width: 260, height: 220 }), 1e-9],
    ['pentagon', geo({ shape: 'polygon', points: 5 }), 1e-9],
    ['64-gon', geo({ shape: 'polygon', points: 64, width: 500, height: 200 }), 1e-9],
    ['5-point star', geo({ shape: 'star', points: 5, innerRadius: 0.45 }), 1e-9],
    ['12-point star, inner 0.8', geo({ shape: 'star', points: 12, innerRadius: 0.8, width: 120, height: 340 }), 1e-9],
    ['star with inner size 0', geo({ shape: 'star', points: 4, innerRadius: 0 }), 1e-9],
    ['line', geo({ shape: 'line', width: 640, height: 30 }), 1e-12],
  ];
  for (const [name, g, tol] of cases) {
    it(name, () => {
      const numeric = polylineLength(trace(g));
      expect(Math.abs(shapeLength(g) - numeric) / numeric, `${shapeLength(g)} vs ${numeric}`).toBeLessThan(tol);
    });
  }

  it('the rounded rect formula is 2(w+h) − 8rr + 2π·rr with rr = min(r, w/2, h/2); a pill is two straights + a circle', () => {
    expect(shapeLength(geo({ width: 300, height: 180, cornerRadius: 24 }))).toBeCloseTo(2 * 480 - 8 * 24 + 2 * Math.PI * 24, 9);
    // Pill 400×120 with r = 500: rr = 60 → 2·(400 − 120) + π·120.
    expect(shapeLength(geo({ width: 400, height: 120, cornerRadius: 500 }))).toBeCloseTo(2 * 280 + Math.PI * 120, 9);
    expect(clampedRadius({ width: 400, height: 120, cornerRadius: 500 })).toBe(60);
    // A negative size (an overshooting spring) draws square corners, so the length is the plain perimeter.
    expect(shapeLength(geo({ width: -100, height: 50, cornerRadius: 10 }))).toBe(300);
  });

  it('ellipse: Ramanujan II, exact for circles and degenerate sizes', () => {
    expect(ellipsePerimeter(50, 50)).toBeCloseTo(2 * Math.PI * 50, 9);
    expect(ellipsePerimeter(0, 0)).toBe(0);
    expect(ellipsePerimeter(-100, 60)).toBe(ellipsePerimeter(100, 60));
  });
});

// ---------------------------------------------------------------- trim dash maths

/** Canvas dash semantics: path position s is drawn when (s + lineDashOffset) mod period falls in the "on" part. */
function drawnAt(t: ReturnType<typeof trimStroke>, length: number, s: number): boolean {
  if (t.kind !== 'dash') return t.kind === 'solid';
  const period = t.dash[0] + t.dash[1];
  return ((((s + t.offset) % period) + period) % period) < t.dash[0];
}

describe('trim paths: dash and offset', () => {
  const Lp = 1000;
  it('setLineDash([v, L − v]) with v = (end − start)·L and offset −(((start + offset) % 1 + 1) % 1)·L', () => {
    expect(trimStroke(Lp, 0, 0.5, 0)).toEqual({ kind: 'dash', dash: [500, 500], offset: 0 });
    expect(trimStroke(Lp, 0.25, 0.75, 0)).toEqual({ kind: 'dash', dash: [500, 500], offset: -250 });
    const wrapped = trimStroke(Lp, 0.6, 0.9, 0.7); // start + offset = 1.3 → wraps to 0.3
    expect(wrapped.kind).toBe('dash');
    if (wrapped.kind === 'dash') {
      expect(wrapped.dash[0]).toBeCloseTo(300, 9);
      expect(wrapped.offset).toBeCloseTo(-300, 9);
    }
    const negative = trimStroke(Lp, 0.1, 0.3, -0.3); // −0.2 → 0.8
    if (negative.kind === 'dash') expect(negative.offset).toBeCloseTo(-800, 9);
    // Wrapped in JS: a huge offset gives the same phase as its fractional part (Skia keeps the phase in float32).
    const huge = trimStroke(Lp, 0, 0.5, 1000.25);
    if (huge.kind === 'dash') expect(huge.offset).toBeCloseTo(-250, 6);
    // Whole turns are no offset at all (not −0).
    expect(trimStroke(Lp, 0, 0.5, 2)).toEqual({ kind: 'dash', dash: [500, 500], offset: 0 });
    expect(Object.is((trimStroke(Lp, 0, 0.5, 2) as { offset: number }).offset, -0)).toBe(false);
  });

  it('v ≤ 0 → no stroke; v ≥ L → solid; values outside 0..1 are clamped', () => {
    expect(trimStroke(Lp, 0, 1, 0)).toEqual({ kind: 'solid' });
    expect(trimStroke(Lp, 0, 1, 0.37)).toEqual({ kind: 'solid' }); // offset alone changes nothing
    expect(trimStroke(Lp, 0.5, 0.5, 0)).toEqual({ kind: 'none' });
    expect(trimStroke(Lp, 0.7, 0.2, 0)).toEqual({ kind: 'none' });
    expect(trimStroke(Lp, -0.5, 1.5, 0)).toEqual({ kind: 'solid' });
    const clamped = trimStroke(Lp, 0.2, 1.5, 0) as Extract<ReturnType<typeof trimStroke>, { kind: 'dash' }>;
    expect(clamped.dash[0]).toBeCloseTo(800, 9);
    expect(clamped.offset).toBeCloseTo(-200, 9);
    expect(trimStroke(0, 0.2, 0.6, 0)).toEqual({ kind: 'none' }); // nothing to draw on a zero-length outline
    expect(trimStroke(0, 0, 1, 0)).toEqual({ kind: 'solid' });
    expect(trimStroke(Number.NaN, 0.2, 0.6, 0)).toEqual({ kind: 'none' });
  });

  it('the dash shows exactly [start + offset, end + offset] (mod 1) of the outline', () => {
    const settings: [number, number, number][] = [[0, 0.3, 0], [0.2, 0.9, 0], [0.6, 0.9, 0.7], [0.1, 0.4, -0.35], [0.05, 0.95, 0.5], [0, 0.01, 0.995], [0.3, 0.6, -2.25]];
    for (const [start, end, offset] of settings) {
      const t = trimStroke(Lp, start, end, offset);
      for (let i = 0; i < 400; i++) {
        const s = (i + 0.5) * (Lp / 400);
        const u = (((s / Lp - start - offset) % 1) + 1) % 1;
        expect(drawnAt(t, Lp, s), `start ${start} end ${end} offset ${offset} at ${s}`).toBe(u < end - start);
      }
    }
  });

  it('shapeTrim measures the outline only when trimmed', () => {
    expect(shapeTrim(shape({ trimEnd: 1 }))).toEqual({ kind: 'solid' });
    const s = shape({ shape: 'ellipse', width: 200, height: 200, trimStart: 0, trimEnd: 0.25 });
    expect(shapeTrim(s)).toEqual({ kind: 'dash', dash: [(2 * Math.PI * 100) / 4, (3 * 2 * Math.PI * 100) / 4], offset: 0 });
  });
});

// ---------------------------------------------------------------- gradients & colours

describe('linear gradients', () => {
  it('runs through the box centre at the angle with half-length (|w cos θ| + |h sin θ|) / 2', () => {
    const close = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).forEach((k) => expect(a[k], k).toBeCloseTo(b[k], 9));
    close(gradientLine(200, 100, 0), { x0: 0, y0: 50, x1: 200, y1: 50 });
    close(gradientLine(200, 100, 90), { x0: 100, y0: 0, x1: 100, y1: 100 });
    close(gradientLine(200, 100, 180), { x0: 200, y0: 50, x1: 0, y1: 50 });
    close(gradientLine(100, 100, 45), { x0: 0, y0: 0, x1: 100, y1: 100 });
    const h = (200 * Math.SQRT1_2 + 100 * Math.SQRT1_2) / 2;
    close(gradientLine(200, 100, 45), { x0: 100 - h * Math.SQRT1_2, y0: 50 - h * Math.SQRT1_2, x1: 100 + h * Math.SQRT1_2, y1: 50 + h * Math.SQRT1_2 });
  });

  it('stops 0 and 1 land on the box corners furthest back / forward along the direction (any angle)', () => {
    for (const [w, h] of [[200, 100], [80, 300], [1, 1]])
      for (let deg = -180; deg <= 360; deg += 17) {
        const l = gradientLine(w, h, deg);
        const dx = l.x1 - l.x0;
        const dy = l.y1 - l.y0;
        const len2 = dx * dx + dy * dy;
        const along = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => ((x - l.x0) * dx + (y - l.y0) * dy) / len2);
        expect(Math.min(...along)).toBeCloseTo(0, 9);
        expect(Math.max(...along)).toBeCloseTo(1, 9);
        expect((l.x0 + l.x1) / 2).toBeCloseTo(w / 2, 9);
        expect((l.y0 + l.y1) / 2).toBeCloseTo(h / 2, 9);
      }
  });
});

describe('"To" colour when switching to Gradient', () => {
  it('equal colours: mixed 45 % toward black when luminance > 0.5, else toward white', () => {
    expect(gradientToFor('#ffffff', '#ffffff')).toBe('#8c8c8c');
    expect(gradientToFor('#000000', '#000')).toBe('#737373');
    expect(gradientToFor('#4f7cff', '#4F7CFF')).toBe('#9eb7ff'); // luminance 0.49 → lighter
    expect(gradientToFor('#ffd23f', '#ffd23f')).toBe('#8c7423'); // luminance 0.82 → darker
    expect(gradientToFor('#ff000080', '#ff000080')).toBe('#ff737380'); // keeps the alpha
    expect(luminance('#808080')).toBeGreaterThan(0.5);
    expect(gradientToFor('#808080', '#808080')).toBe('#464646');
  });

  it('different colours are kept', () => {
    expect(gradientToFor('#4f7cff', '#ffffff')).toBeNull();
    expect(gradientToFor('#ffffff', '#fffffe')).toBeNull();
    expect(mixColor('#204060', '#ffffff', 0)).toBe('#204060');
    expect(mixColor('#204060', '#ffffff', 1)).toBe('#ffffff');
  });
});

// ---------------------------------------------------------------- Draw on preset

describe('"Draw on" preset', () => {
  const P = (over: Partial<PresetParams>): PresetParams => ({ kind: 'draw', phase: 'in', direction: 'up', distance: 0, delay: 0.2, duration: 0.8, easing: { type: 'easeOut' }, ...over });
  it('animates trimEnd only, so it applies to shapes only', () => {
    expect(presetProps({ kind: 'draw', direction: 'up' })).toEqual(['trimEnd']);
    expect(presetApplies(shape(), P({}))).toBe(true);
    expect(presetApplies(text(), P({}))).toBe(false);
    expect(presetApplies(L({ type: 'image', assetId: 'a', width: 10, height: 10 }), P({}))).toBe(false);
    const t = text();
    expect(applyPreset(t, P({}))).toBe(t.keyframes);
  });

  it('in: trim end 0 → 1 from the delay; out: 1 → 0 ending `delay` before the layer ends; re-applying replaces', () => {
    const s = shape({ trimEnd: 0.4, duration: 3 });
    const kIn = applyPreset(s, P({}));
    expect(Object.keys(kIn)).toEqual(['trimEnd']);
    expect(kIn.trimEnd.map((k) => [k.time, k.value, k.source, k.easing.type])).toEqual([[0.2, 0, 'preset:in', 'easeOut'], [1, 1, 'preset:in', 'easeOut']]);
    const both = applyPreset({ ...s, keyframes: kIn }, P({ phase: 'out', delay: 0.5, easing: { type: 'easeIn' } }));
    expect(both.trimEnd.map((k) => [k.time, k.value, k.source])).toEqual([[0.2, 0, 'preset:in'], [1, 1, 'preset:in'], [1.7, 1, 'preset:out'], [2.5, 0, 'preset:out']]);
    const again = applyPreset({ ...s, keyframes: both }, P({ delay: 0, duration: 0.5 }));
    expect(again.trimEnd.map((k) => [k.time, k.value])).toEqual([[0, 0], [0.5, 1], [1.7, 1], [2.5, 0]]);
  });
});

// ---------------------------------------------------------------- draw calls

const IMAGES = new Map<string, CanvasImageSource>();
function draw(layer: Layer, local = 0.5, scale = 1) {
  const rec = recordingCtx(4000, 3000);
  rec.ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawLayer(rec.ctx, layer, local, { images: IMAGES, canvasPool: rec.pool }, scale);
  return rec;
}
const calls = (log: string[]) => log.map(parseEntry);
const index = (log: string[], prefix: string) => log.findIndex((l) => l.startsWith(prefix));

describe('shape drawing', () => {
  it('a trimmed outline: dash + offset + line ends, set right before the stroke; the fill is untouched', () => {
    const s = shape({ cornerRadius: 30, strokeWidth: 12, trimStart: 0.1, trimEnd: 0.6, trimOffset: 0.2, lineCap: 'butt' });
    const Lr = shapeLength(s);
    const log = draw(s).log;
    const tail = log.slice(index(log, 'fill('));
    expect(tail[0]).toBe('fill([])');
    expect(tail.slice(1, 7).map((l) => l.replace(/-?\d+(\.\d+)?(e-?\d+)?/g, (n) => String(Math.round(Number(n) * 1000) / 1000)))).toEqual([
      'lineWidth=12',
      'strokeStyle="#ffffff"',
      'lineCap="butt"',
      `setLineDash([[${Math.round(0.5 * Lr * 1000) / 1000},${Math.round(0.5 * Lr * 1000) / 1000}]])`,
      `lineDashOffset=${Math.round(-0.3 * Lr * 1000) / 1000}`,
      'stroke([])',
    ]);
    expect(log[index(log, 'beginPath') + 1]).toBe('moveTo([30,0])');
  });

  it('untrimmed outlines draw exactly like v1 (no dash, no line ends); a fully trimmed one draws no outline', () => {
    const plain = draw(shape({ shape: 'ellipse', strokeWidth: 8 })).log;
    expect(plain.some((l) => /setLineDash|lineDashOffset|lineCap|closePath/.test(l))).toBe(false);
    expect(plain).toContain(`ellipse([150,90,150,90,0,0,${2 * Math.PI}])`);
    expect(plain).toContain('stroke([])');
    const hidden = draw(shape({ strokeWidth: 8, trimStart: 0.4, trimEnd: 0.4 })).log;
    expect(hidden).toContain('fill([])');
    expect(hidden).not.toContain('stroke([])');
    // A trimmed ellipse starts at 12 o'clock.
    const trimmed = draw(shape({ shape: 'ellipse', strokeWidth: 8, trimEnd: 0.5 })).log;
    expect(trimmed).toContain(`ellipse([150,90,150,90,0,${-Math.PI / 2},${(3 * Math.PI) / 2}])`);
  });

  it('a line is stroke only, with its line ends; star / polygon / triangle are closed polygons', () => {
    const line = draw(shape({ shape: 'line', width: 400, height: 20, strokeWidth: 10, fill: '#ff0000' })).log;
    expect(line.some((l) => l.startsWith('fill('))).toBe(false);
    expect(line.slice(index(line, 'beginPath'), index(line, 'stroke(') + 1)).toEqual(['beginPath([])', 'moveTo([0,10])', 'lineTo([400,10])', 'lineWidth=10', 'strokeStyle="#ffffff"', 'lineCap="round"', 'stroke([])']);
    const star = calls(draw(shape({ shape: 'star', points: 6, strokeWidth: 4 })).log);
    expect(star.filter((c) => 'call' in c && c.call === 'lineTo')).toHaveLength(11);
    expect(star.some((c) => 'call' in c && c.call === 'closePath')).toBe(true);
  });

  it('gradient fill: one linear gradient across the layer box, stop 0 = fill, stop 1 = To', () => {
    const log = draw(shape({ width: 200, height: 100, fillMode: 'linear', fill: '#ff0000', gradientTo: '#0000ff', gradientAngle: 0 })).log;
    const g = index(log, 'createLinearGradient');
    expect(log.slice(g, g + 4)).toEqual(['createLinearGradient([0,50,200,50])', 'addColorStop([0,"#ff0000"])', 'addColorStop([1,"#0000ff"])', 'fillStyle={}']);
    expect(log[g + 4]).toBe('fill([])');
  });

  it('a line with a drop shadow is a single draw (no scratch canvas); an outlined rect with one is isolated', () => {
    const fx = { shadow: true, shadowColor: '#000000aa', shadowBlur: 6, shadowOffsetY: 4 };
    expect(draw(shape({ shape: 'line', strokeWidth: 10, ...fx })).children).toHaveLength(0);
    expect(draw(shape({ strokeWidth: 10, ...fx })).children).toHaveLength(1);
  });

  it('is deterministic', () => {
    const s = shape({ shape: 'star', strokeWidth: 9, trimStart: 0.2, trimEnd: 0.7, trimOffset: 0.9, fillMode: 'linear', gradientAngle: 33, gradientTo: '#00ff00' });
    expect(draw(s).log).toEqual(draw(s).log);
  });
});

describe('text outline and gradient', () => {
  it('outline: round joins, every line stroked before any line is filled', () => {
    const log = draw(text({ strokeWidth: 12, stroke: '#112233' })).log;
    const strokes = log.map((l, i) => (l.startsWith('strokeText') ? i : -1)).filter((i) => i >= 0);
    const fills = log.map((l, i) => (l.startsWith('fillText') ? i : -1)).filter((i) => i >= 0);
    expect(strokes).toHaveLength(2);
    expect(fills).toHaveLength(2);
    expect(Math.max(...strokes)).toBeLessThan(Math.min(...fills));
    expect(log).toContain('lineJoin="round"');
    expect(log).toContain('lineWidth=12');
    expect(log).toContain('strokeStyle="#112233"');
    expect(log[strokes[0]]).toBe(log[fills[0]].replace('fillText', 'strokeText'));
  });

  it('gradient: across the text box (recorder metrics: 10 px per character, line height 100)', () => {
    const log = draw(text({ fillMode: 'linear', color: '#ff0000', gradientTo: '#00ff00', gradientAngle: 90 })).log;
    // 'Hello' / 'World': box 50 × 200 (2 lines × 80 × 1.25); 90° = top → bottom through the centre.
    const g = log.find((l) => l.startsWith('createLinearGradient'))!;
    const [x0, y0, x1, y1] = (parseEntry(g) as { args: number[] }).args;
    [x0, y0, x1, y1].forEach((v, i) => expect(v).toBeCloseTo([25, 0, 25, 200][i], 9));
    expect(log).toContain('addColorStop([0,"#ff0000"])');
    expect(log).toContain('addColorStop([1,"#00ff00"])');
  });

  it('animated units: one gradient for all of them, outlines of every unit before any fill', () => {
    const t = text({ strokeWidth: 6, fillMode: 'linear', gradientTo: '#000000' });
    const rec = recordingCtx(2000, 1000);
    const units = ['He', 'llo'].map((s, i) => ({ line: 0, start: i * 2, end: i * 2 + s.length, text: s, x: i * 20, y: 50, width: s.length * 10, ink: { x0: i * 20, y0: 42, x1: i * 20 + s.length * 10, y1: 52 }, look: { alpha: 0.5 + i * 0.5, s: 1, tx: 0, ty: i * 5, blurs: [] } }));
    drawTextUnits(rec.ctx, t, units, 1, [1, 0, 0, 1, 0, 0]);
    const log = rec.log;
    expect(log.filter((l) => l.startsWith('createLinearGradient'))).toHaveLength(1);
    const ops = log.filter((l) => /^(strokeText|fillText)/.test(l)).map((l) => l.slice(0, l.indexOf('(')) + ':' + JSON.parse(l.slice(l.indexOf('(') + 1, -1))[0]);
    expect(ops).toEqual(['strokeText:He', 'strokeText:llo', 'fillText:He', 'fillText:llo']);
  });

  it('partly transparent outlined text is drawn as one group (opacity applied once, at the composite)', () => {
    const faded = draw(text({ strokeWidth: 12, opacity: 0.5 }));
    expect(faded.children).toHaveLength(1);
    const composite = faded.log.findIndex((l) => l.startsWith('drawImage(["<canvas main.0>"'));
    expect(faded.log.slice(0, composite)).toContain('globalAlpha=0.5');
    const scratch = faded.children[0].log;
    expect(scratch.some((l) => l.startsWith('globalAlpha='))).toBe(false);
    expect(scratch.filter((l) => /^(strokeText|fillText)/.test(l))).toHaveLength(4);
    // A fade (opacity keyframes): grouped while see-through, straight onto the canvas once opaque.
    const fade = text({ strokeWidth: 12, keyframes: { opacity: [{ id: 'a', time: 0, value: 0, easing: { type: 'linear' } }, { id: 'b', time: 1, value: 1, easing: { type: 'linear' } }] } });
    expect(draw(fade, 0.5).children).toHaveLength(1);
    expect(draw(fade, 1.5).children).toHaveLength(0);
    // Opaque outlined text, and see-through text without an outline, keep the direct (v1) path.
    expect(draw(text({ strokeWidth: 12 })).children).toHaveLength(0);
    expect(draw(text({ opacity: 0.5 })).children).toHaveLength(0);
  });

  it('no outline and a solid colour: exactly the plain fill calls (v1)', () => {
    const log = draw(text()).log;
    expect(log.some((l) => /strokeText|lineJoin|createLinearGradient/.test(l))).toBe(false);
    expect(log).toContain('fillStyle="#ffffff"');
  });
});

// ---------------------------------------------------------------- inkBounds

describe('inkBounds contains everything the new shapes paint', () => {
  const cases: [string, Layer][] = [
    ['triangle, thick outline, rotated', shape({ shape: 'triangle', strokeWidth: 30, rotation: 25 })],
    ['spiky star, mirrored', shape({ shape: 'star', points: 7, innerRadius: 0.2, strokeWidth: 18, scale: -1.4 })],
    ['polygon, trimmed', shape({ shape: 'polygon', points: 9, strokeWidth: 12, trimStart: 0.3, trimEnd: 0.8, trimOffset: 0.6 })],
    ['line with square ends, rotated', shape({ shape: 'line', width: 500, height: 4, strokeWidth: 40, lineCap: 'square', rotation: 60 })],
    ['trimmed ellipse with square ends', shape({ shape: 'ellipse', width: 60, height: 60, strokeWidth: 50, trimEnd: 0.3, lineCap: 'square', rotation: 10 })],
    ['gradient rect, trimmed outline', shape({ cornerRadius: 40, strokeWidth: 16, trimEnd: 0.5, fillMode: 'linear', gradientAngle: 45 })],
    ['outlined gradient text', text({ strokeWidth: 20, fillMode: 'linear', rotation: -12 })],
  ];
  for (const [name, layer] of cases) {
    it(name, () => {
      for (const scale of [1, 0.37, 2]) {
        const rec = recordingCtx(4000, 3000);
        const ink = inkBounds(layer, 0.5, scale, rec.ctx);
        rec.reset();
        rec.ctx.setTransform(scale, 0, 0, scale, 0, 0);
        drawLayer(rec.ctx, layer, 0.5, { images: IMAGES }, scale);
        const pts = drawnPoints(rec.log);
        expect(pts.length).toBeGreaterThan(0);
        expect(pts.filter((p) => p.x < ink.x0 - 1e-6 || p.x > ink.x1 + 1e-6 || p.y < ink.y0 - 1e-6 || p.y > ink.y1 + 1e-6), `${name} @${scale}`).toEqual([]);
      }
    });
  }

  it('square line ends widen the box by √2 × half the width only where ends show', () => {
    const w = (l: Layer) => {
      const b = inkBounds(l, 0, 1, recordingCtx().ctx);
      return b.x1 - b.x0;
    };
    const round = shape({ shape: 'ellipse', width: 100, height: 100, strokeWidth: 40, trimEnd: 0.5 });
    expect(w({ ...round, lineCap: 'square' })).toBeGreaterThan(w(round));
    // Untrimmed closed outlines have no ends: the line-end setting changes nothing.
    expect(w({ ...round, trimEnd: 1, lineCap: 'square' })).toBe(w({ ...round, trimEnd: 1 }));
  });
});
