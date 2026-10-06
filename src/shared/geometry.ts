// Layer geometry shared by renderFrame, inkBounds and the editor overlay: text metrics, layer boxes, transforms and
// cursor motion. Pure functions (text measuring needs a 2D context but leaves its state unchanged).
import { applyEasing } from './easing';
import type { CursorLayer, Layer, TextLayer } from './schema';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function fontString(layer: Pick<TextLayer, 'fontWeight' | 'fontSize' | 'fontFamily'>): string {
  const fam = /[\s,'"]/.test(layer.fontFamily) && !layer.fontFamily.includes(',') ? `"${layer.fontFamily}"` : layer.fontFamily;
  return `${layer.fontWeight} ${layer.fontSize}px ${fam}, sans-serif`;
}

export function setLetterSpacing(ctx: Ctx2D, px: number) {
  const c = ctx as Ctx2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${px}px`;
}

export interface TextMetricsBox {
  w: number;
  h: number;
  lines: { text: string; width: number }[];
  lineHeightPx: number;
}

export function measureText(ctx: Ctx2D, layer: TextLayer): TextMetricsBox {
  ctx.save();
  ctx.font = fontString(layer);
  setLetterSpacing(ctx, layer.letterSpacing);
  const lines = layer.content.split('\n').map((text) => ({ text, width: ctx.measureText(text).width }));
  ctx.restore();
  const lineHeightPx = layer.fontSize * layer.lineHeight;
  const w = Math.max(1, ...lines.map((l) => l.width));
  return { w, h: Math.max(1, lines.length * lineHeightPx), lines, lineHeightPx };
}

/** Left edge of a line inside the text box (lines are drawn with textAlign 'left' at this x). */
export function lineX(align: TextLayer['align'], boxW: number, lineW: number): number {
  return align === 'left' ? 0 : align === 'center' ? (boxW - lineW) / 2 : boxW - lineW;
}

/** Size of the layer's content box (before transform). */
export function layerBox(ctx: Ctx2D, layer: Layer): { w: number; h: number } {
  switch (layer.type) {
    case 'text': {
      const m = measureText(ctx, layer);
      return { w: m.w, h: m.h };
    }
    case 'image':
    case 'shape':
      return { w: layer.width, h: layer.height };
    case 'cursor':
      return { w: layer.size, h: layer.size * 1.5 };
  }
}

/** 2D affine matrix [a,b,c,d,e,f] mapping layer-box coords to project coords. */
export type Matrix = [number, number, number, number, number, number];

export function layerMatrix(layer: Layer, box: { w: number; h: number }): Matrix {
  const r = (layer.rotation * Math.PI) / 180;
  const cos = Math.cos(r) * layer.scale;
  const sin = Math.sin(r) * layer.scale;
  const ax = layer.anchorX * box.w;
  const ay = layer.anchorY * box.h;
  // T(x,y) * R * S * T(-ax,-ay)
  return [cos, sin, -sin, cos, layer.x - (cos * ax - sin * ay), layer.y - (sin * ax + cos * ay)];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** a × b (b is applied first), like ctx.transform(b) on a context whose transform is a. */
export function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// ---------------------------------------------------------------- cursor

export const CURSOR_PRESS_SEC = 0.15;
export const CURSOR_RIPPLE_SEC = 0.5;
/** Classic arrow pointer, tip at (0,0), in a 24-unit box (scaled by size / 24). */
export const CURSOR_ARROW: readonly (readonly [number, number])[] = [[0, 0], [0, 25], [6, 19.5], [10, 28.5], [14, 26.8], [10.2, 18], [18, 18]];
/** Outline width of the arrow, in the same 24-unit space (round joins). */
export const CURSOR_OUTLINE = 1.8;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Cursor tip position at layer-local time. */
export function cursorPosition(layer: CursorLayer, local: number): { x: number; y: number } {
  const pts = [...layer.points].sort((a, b) => a.time - b.time);
  if (pts.length === 0) return { x: layer.x, y: layer.y };
  if (local <= pts[0].time) return { x: pts[0].x, y: pts[0].y };
  const last = pts[pts.length - 1];
  if (local >= last.time) return { x: last.x, y: last.y };
  let i = 0;
  while (i < pts.length - 2 && local >= pts[i + 1].time) i++;
  const a = pts[i];
  const b = pts[i + 1];
  const span = b.time - a.time;
  const p = applyEasing({ type: 'easeInOut' }, span <= 0 ? 1 : (local - a.time) / span);
  const p0 = pts[i - 1] ?? a;
  const p3 = pts[i + 2] ?? b;
  const lx = a.x + (b.x - a.x) * p;
  const ly = a.y + (b.y - a.y) * p;
  const cx = catmull(p0.x, a.x, b.x, p3.x, p);
  const cy = catmull(p0.y, a.y, b.y, p3.y, p);
  const s = layer.smoothing;
  return { x: lx + (cx - lx) * s, y: ly + (cy - ly) * s };
}

/** Click ripples visible at layer-local time: radius in project px (signed by the layer scale) and fade factor. */
export function cursorRipples(layer: CursorLayer, local: number): { radius: number; alpha: number }[] {
  const out: { radius: number; alpha: number }[] = [];
  for (const click of layer.clicks) {
    const dt = local - click.time;
    if (dt < 0 || dt >= CURSOR_RIPPLE_SEC) continue;
    const p = dt / CURSOR_RIPPLE_SEC;
    const eased = applyEasing({ type: 'easeOut' }, p);
    out.push({ radius: layer.size * (0.2 + 1.3 * eased) * layer.scale, alpha: 1 - p });
  }
  return out;
}

/** Pointer scale while clicking: 1 normally, dipping to 0.82 during a press. */
export function cursorPress(layer: CursorLayer, local: number): number {
  let press = 1;
  for (const click of layer.clicks) {
    const dt = local - click.time;
    if (dt >= 0 && dt < CURSOR_PRESS_SEC) press = Math.min(press, 1 - 0.18 * Math.sin((dt / CURSOR_PRESS_SEC) * Math.PI));
  }
  return press;
}

// ---------------------------------------------------------------- device boxes

/** Axis-aligned box in canvas pixels (x1/y1 exclusive). Empty when x1 <= x0 or y1 <= y0. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const EMPTY_BOX: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };

export const isEmptyBox = (b: Box) => !(b.x1 > b.x0 && b.y1 > b.y0);

export function unionBox(a: Box, b: Box): Box {
  if (isEmptyBox(a)) return b;
  if (isEmptyBox(b)) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function intersectBox(a: Box, b: Box): Box {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return isEmptyBox(r) ? EMPTY_BOX : r;
}

export function inflateBox(b: Box, dx: number, dy = dx): Box {
  return isEmptyBox(b) ? b : { x0: b.x0 - dx, y0: b.y0 - dy, x1: b.x1 + dx, y1: b.y1 + dy };
}

export function translateBox(b: Box, dx: number, dy: number): Box {
  return isEmptyBox(b) ? b : { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
}

/** Smallest whole-pixel box containing `b`. */
export function roundOutBox(b: Box): Box {
  return isEmptyBox(b) ? EMPTY_BOX : { x0: Math.floor(b.x0), y0: Math.floor(b.y0), x1: Math.ceil(b.x1), y1: Math.ceil(b.y1) };
}

/** Bounding box of points. */
export function boxOfPoints(points: readonly (readonly [number, number])[]): Box {
  if (points.length === 0) return EMPTY_BOX;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Bounding box of `b` mapped through `m`. */
export function transformBox(m: Matrix, b: Box): Box {
  if (isEmptyBox(b)) return EMPTY_BOX;
  return boxOfPoints(([[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]] as const).map(([x, y]) => applyMatrix(m, x, y)));
}
