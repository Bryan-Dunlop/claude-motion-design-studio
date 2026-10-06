// Ink bounds: the canvas-pixel box that contains everything drawLayer paints for a layer at a given time (for a
// project → canvas mapping of `scale` with origin 0). One function used everywhere: the clip region of filtered draws,
// the scratch canvas of isolated layers, and the unit test checking every drawn coordinate lies inside it.
// The cursor is drawn at cursorPosition(local), not inside its layer box.
import { clampResolved } from './effects';
import {
  applyMatrix,
  boxOfPoints,
  CURSOR_ARROW,
  CURSOR_OUTLINE,
  cursorPosition,
  cursorRipples,
  EMPTY_BOX,
  fontString,
  inflateBox,
  isEmptyBox,
  layerMatrix,
  lineX,
  roundOutBox,
  setLetterSpacing,
  unionBox,
  type Box,
  type Ctx2D,
} from './geometry';
import { resolveLayer } from './interpolate';
import type { CursorLayer, ImageLayer, Layer, ShapeLayer, TextLayer } from './schema';

/** Antialiasing fringe around drawn edges, in canvas pixels. */
const AA_PAD = 2;
/** Safety margin around measured glyph boxes, as a fraction of the font size. */
const GLYPH_PAD = 0.06;
/** Canvas default miterLimit: a sharp corner's miter can reach miterLimit × lineWidth / 2 from the path. */
export const MITER_LIMIT = 10;

const ARROW_W = Math.max(...CURSOR_ARROW.map((p) => p[0]));
const ARROW_H = Math.max(...CURSOR_ARROW.map((p) => p[1]));

const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/** Ink of a text layer in its layer box, plus that box (lines laid out exactly like drawText). */
function textInk(ctx: Ctx2D, layer: TextLayer): { ink: Box; box: { w: number; h: number } } {
  ctx.save();
  ctx.font = fontString(layer);
  setLetterSpacing(ctx, layer.letterSpacing);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lines = layer.content.split('\n').map((text) => ({ text, m: ctx.measureText(text) }));
  ctx.restore();
  const lh = layer.fontSize * layer.lineHeight;
  const box = { w: Math.max(1, ...lines.map((l) => l.m.width)), h: Math.max(1, lines.length * lh) };
  let ink = EMPTY_BOX;
  lines.forEach(({ text, m }, i) => {
    if (!text.trim()) return;
    const x = lineX(layer.align, box.w, m.width);
    const y = i * lh + lh / 2;
    ink = unionBox(ink, {
      x0: x - finite(m.actualBoundingBoxLeft, 0),
      x1: x + finite(m.actualBoundingBoxRight, m.width),
      y0: y - finite(m.actualBoundingBoxAscent, layer.fontSize),
      y1: y + finite(m.actualBoundingBoxDescent, layer.fontSize),
    });
  });
  // Outline (strokeText, round joins) and a little glyph overhang.
  ink = inflateBox(ink, layer.fontSize * GLYPH_PAD + layer.strokeWidth / 2);
  // Text animators move units up/down by up to |distance| (rise/drop).
  let dy = 0;
  for (const a of [layer.textIn, layer.textOut]) if (a && (a.effect === 'rise' || a.effect === 'drop')) dy = Math.max(dy, Math.abs(a.distance));
  return { ink: inflateBox(ink, 0, dy), box };
}

/** Sharp corners whose miter can stick out further than half the line width. */
function hasAcuteCorners(layer: ShapeLayer): boolean {
  return layer.shape === 'triangle' || layer.shape === 'star' || layer.shape === 'polygon';
}

function signedBox(w: number, h: number): Box {
  return { x0: Math.min(0, w), y0: Math.min(0, h), x1: Math.max(0, w), y1: Math.max(0, h) };
}

function shapeInk(layer: ShapeLayer): Box {
  const box = signedBox(layer.width, layer.height);
  if (layer.strokeWidth <= 0) return box;
  // Rects (90° miters reach the corner of the box grown by half the width), ellipses and lines: × 1.
  return inflateBox(box, (layer.strokeWidth / 2) * (hasAcuteCorners(layer) ? MITER_LIMIT : 1));
}

function imageInk(layer: ImageLayer): Box {
  // Covers the missing-file placeholder's outline too (lineWidth max(2, w/200), centred on the box edge).
  return inflateBox(signedBox(layer.width, layer.height), Math.max(2, layer.width / 200) / 2);
}

function cursorInk(layer: CursorLayer, local: number): Box {
  const pos = cursorPosition(layer, local);
  // A press only shrinks the arrow towards its tip, so the unpressed arrow bounds it.
  const s = (layer.size / 24) * layer.scale;
  const h = CURSOR_OUTLINE / 2;
  let box = boxOfPoints([
    [pos.x - h * s, pos.y - h * s],
    [pos.x + (ARROW_W + h) * s, pos.y + (ARROW_H + h) * s],
  ]);
  for (const r of cursorRipples(layer, local)) {
    const R = Math.abs(r.radius);
    box = unionBox(box, { x0: pos.x - R, y0: pos.y - R, x1: pos.x + R, y1: pos.y + R });
  }
  return box;
}

/** inkBounds for a layer whose properties are already resolved (and clamped) at `local`. */
export function inkBoundsResolved(layer: Layer, local: number, scale: number, ctx: Ctx2D): Box {
  let device: Box;
  let extra = 0;
  if (layer.type === 'cursor') {
    const b = cursorInk(layer, local);
    device = { x0: b.x0 * scale, y0: b.y0 * scale, x1: b.x1 * scale, y1: b.y1 * scale };
  } else {
    let ink: Box;
    let box: { w: number; h: number };
    if (layer.type === 'text') {
      ({ ink, box } = textInk(ctx, layer));
      // Per-unit blur of a "Blur" text animator: up to |distance| × k canvas px, spreading 3×.
      for (const a of [layer.textIn, layer.textOut]) if (a?.effect === 'blur') extra = Math.max(extra, 3 * Math.abs(a.distance) * scale * Math.abs(layer.scale));
    } else {
      ink = layer.type === 'shape' ? shapeInk(layer) : imageInk(layer);
      box = { w: layer.width, h: layer.height };
    }
    if (isEmptyBox(ink)) return EMPTY_BOX;
    const m = layerMatrix(layer, box);
    const corners = ([[ink.x0, ink.y0], [ink.x1, ink.y0], [ink.x1, ink.y1], [ink.x0, ink.y1]] as const).map(([x, y]) => {
      const [px, py] = applyMatrix(m, x, y);
      return [px * scale, py * scale] as const;
    });
    device = boxOfPoints(corners);
  }
  return roundOutBox(inflateBox(device, AA_PAD + extra));
}

/**
 * Canvas-pixel box containing everything drawLayer paints for `layer` at layer-local time `local`, at render scale
 * `scale` (canvas origin = project origin). `ctx` is only used to measure text (its state is left unchanged).
 */
export function inkBounds(layer: Layer, local: number, scale: number, ctx: Ctx2D): Box {
  return inkBoundsResolved(clampResolved(resolveLayer(layer, local)), local, scale, ctx);
}
