// Shape geometry (docs/v2-plan.md A3): outline paths with fixed start points, exact outline lengths, trim-path dash
// maths, linear-gradient endpoints and the gradient "To" colour rule. Pure: path builders only issue path calls on the
// context they are given.
import type { Ctx2D } from './geometry';
import { formatColor, lerp, parseColor } from './interpolate';
import type { ShapeLayer } from './schema';

export type ShapeGeometry = Pick<ShapeLayer, 'shape' | 'width' | 'height' | 'cornerRadius' | 'points' | 'innerRadius'>;
export type PathSink = Pick<Ctx2D, 'beginPath' | 'moveTo' | 'lineTo' | 'arcTo' | 'ellipse' | 'closePath'>;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Corner radius actually drawn: at most half the shorter side, never negative (arcTo throws on a negative radius). */
export const clampedRadius = (g: Pick<ShapeGeometry, 'width' | 'height' | 'cornerRadius'>) => Math.max(0, Math.min(g.cornerRadius, g.width / 2, g.height / 2));

/**
 * Corners of the polygonal kinds in path order, clockwise on screen: triangle (w/2,0) (w,h) (0,h); polygon `points`
 * sides and star `points` tips (inner corners at innerRadius × the outer radius) on the ellipse with radii w/2, h/2,
 * vertex 0 at the top; line (0,h/2) → (w,h/2). Empty for rect and ellipse.
 */
export function shapeVertices(g: ShapeGeometry): [number, number][] {
  const { width: w, height: h } = g;
  switch (g.shape) {
    case 'triangle':
      return [[w / 2, 0], [w, h], [0, h]];
    case 'line':
      return [[0, h / 2], [w, h / 2]];
    case 'polygon':
    case 'star': {
      const n = Math.max(3, Math.min(64, Math.round(g.points)));
      const star = g.shape === 'star';
      const count = star ? 2 * n : n;
      const inner = clamp01(g.innerRadius);
      const out: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / count;
        const r = star && i % 2 === 1 ? inner : 1;
        out.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)]);
      }
      return out;
    }
    default:
      return [];
  }
}

/**
 * Add the shape's outline to `ctx` as a new path (layer-box coordinates), clockwise on screen. Rect: starts on the top
 * edge just after the top-left corner radius. Polygon / star / triangle: at vertex 0 (top). Line: at the left end.
 * Ellipse: a trimmed outline (`outline` true) starts at 12 o'clock and is closed, so a trim wrapping past the start
 * joins up; otherwise v1's exact call is kept (where a full ellipse starts doesn't show).
 */
export function traceShape(ctx: PathSink, g: ShapeGeometry, outline = false) {
  const { width: w, height: h } = g;
  ctx.beginPath();
  if (g.shape === 'rect') {
    const rr = clampedRadius(g);
    ctx.moveTo(rr, 0);
    ctx.arcTo(w, 0, w, h, rr);
    ctx.arcTo(w, h, 0, h, rr);
    ctx.arcTo(0, h, 0, 0, rr);
    ctx.arcTo(0, 0, w, 0, rr);
    ctx.closePath();
  } else if (g.shape === 'ellipse') {
    const a0 = outline ? -Math.PI / 2 : 0;
    ctx.ellipse(w / 2, h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, a0, a0 + Math.PI * 2);
    if (outline) ctx.closePath();
  } else {
    const pts = shapeVertices(g);
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (g.shape !== 'line') ctx.closePath();
  }
}

/** Ellipse circumference, Ramanujan's second approximation (relative error < 4e-4 even for a flat ellipse). */
export function ellipsePerimeter(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  if (a + b === 0) return 0;
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/** Length of the outline traceShape draws: rounded rect 2(w+h) − 8rr + 2π·rr with the clamped radius rr; ellipse Ramanujan II; others exact. */
export function shapeLength(g: ShapeGeometry): number {
  const w = Math.abs(g.width);
  const h = Math.abs(g.height);
  if (g.shape === 'rect') {
    const rr = clampedRadius(g);
    return 2 * (w + h) - 8 * rr + 2 * Math.PI * rr;
  }
  if (g.shape === 'ellipse') return ellipsePerimeter(w / 2, h / 2);
  const pts = shapeVertices(g);
  const closed = g.shape !== 'line';
  let length = 0;
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    length += Math.hypot(x1 - x0, y1 - y0);
  }
  return length;
}

// ---------------------------------------------------------------- trim paths

export type TrimStroke = { kind: 'solid' } | { kind: 'none' } | { kind: 'dash'; dash: [number, number]; offset: number };

const SOLID: TrimStroke = { kind: 'solid' };
const NONE: TrimStroke = { kind: 'none' };

/**
 * How to stroke an outline of length L trimmed to [start, end] (fractions of L) and slid by `offset` (wraps around):
 * v = (end − start)·L clamped to [0, L]; v ≤ 0 → no stroke; v ≥ L → solid; else setLineDash([v, L − v]) with
 * lineDashOffset = −(((start + offset) % 1 + 1) % 1)·L. The wrap happens here in JS because Skia keeps the dash phase
 * in float32 (a large offset would drift).
 */
export function trimStroke(length: number, start: number, end: number, offset: number): TrimStroke {
  const s = clamp01(start);
  const f = clamp01(end) - s;
  if (f >= 1) return SOLID;
  const L = Number.isFinite(length) && length > 0 ? length : 0;
  const v = Math.min(L, Math.max(0, f * L));
  if (v <= 0) return NONE;
  if (v >= L) return SOLID;
  const phase = (((s + offset) % 1) + 1) % 1;
  return { kind: 'dash', dash: [v, L - v], offset: phase > 0 ? -phase * L : 0 };
}

/** The trim of a resolved shape layer (untrimmed shapes never measure their outline). */
export function shapeTrim(layer: ShapeGeometry & Pick<ShapeLayer, 'trimStart' | 'trimEnd' | 'trimOffset'>): TrimStroke {
  if (!(layer.trimStart > 0) && !(layer.trimEnd < 1)) return SOLID;
  return trimStroke(shapeLength(layer), layer.trimStart, layer.trimEnd, layer.trimOffset);
}

// ---------------------------------------------------------------- gradients

/**
 * Linear gradient line in a w×h box: through the box centre at `angleDeg` (0 = left → right, 90 = top → bottom), with
 * half-length (|w cos θ| + |h sin θ|) / 2, so stops 0 and 1 land on the box's extreme corners/edges along that direction.
 */
export function gradientLine(w: number, h: number, angleDeg: number): { x0: number; y0: number; x1: number; y1: number } {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const half = (Math.abs(w * c) + Math.abs(h * s)) / 2;
  return { x0: w / 2 - half * c, y0: h / 2 - half * s, x1: w / 2 + half * c, y1: h / 2 + half * s };
}

function addStop(g: CanvasGradient, offset: number, color: string) {
  try {
    g.addColorStop(offset, color);
  } catch {
    // addColorStop throws on a colour the canvas can't parse (fillStyle would just ignore it): use transparent.
    g.addColorStop(offset, 'rgba(0,0,0,0)');
  }
}

/** Gradient fill for a w×h box (layer-box coordinates): stop 0 = `from`, stop 1 = `to`. */
export function linearGradient(ctx: Pick<Ctx2D, 'createLinearGradient'>, w: number, h: number, angleDeg: number, from: string, to: string): CanvasGradient {
  const l = gradientLine(w, h, angleDeg);
  const g = ctx.createLinearGradient(l.x0, l.y0, l.x1, l.y1);
  addStop(g, 0, from);
  addStop(g, 1, to);
  return g;
}

/** Luminance (0..1) as Rec. 709 luma of the sRGB values. Colours are mixed in sRGB, so 0.5 splits "mix darker" from "mix lighter" evenly. */
export function luminance(color: string): number {
  const [r, g, b] = parseColor(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** `color` moved `amount` (0..1) of the way toward `target` in sRGB; keeps `color`'s alpha. */
export function mixColor(color: string, target: string, amount: number): string {
  const a = parseColor(color);
  const t = parseColor(target);
  return formatColor([lerp(a[0], t[0], amount), lerp(a[1], t[1], amount), lerp(a[2], t[2], amount), a[3]]);
}

export function sameColor(a: string, b: string): boolean {
  const x = parseColor(a);
  const y = parseColor(b);
  return x.every((v, i) => Math.abs(v - y[i]) < (i === 3 ? 1 / 510 : 0.5));
}

/**
 * Switching a fill to Gradient: when its "To" colour equals the base colour the gradient would be invisible, so "To"
 * becomes the base mixed 45 % toward black (luminance > 0.5) or white. Returns the new "To" colour, or null to keep it.
 */
export function gradientToFor(base: string, gradientTo: string): string | null {
  if (!sameColor(base, gradientTo)) return null;
  return mixColor(base, luminance(base) > 0.5 ? '#000000' : '#ffffff', 0.45);
}
