// Ink bounds: the canvas-pixel box that contains everything drawLayer paints for a layer at a given time (for a
// project → canvas mapping of `scale` with origin 0). One function used everywhere: the clip region of filtered draws,
// the scratch canvas of isolated layers, and the unit test checking every drawn coordinate lies inside it.
// The cursor is drawn at cursorPosition(local), not inside its layer box.
import { blurMargin, clampResolved } from './effects';
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
  lineIsRtl,
  lineX,
  roundOutBox,
  setLetterSpacing,
  unionBox,
  type Box,
  type Ctx2D,
} from './geometry';
import { resolveLayer } from './interpolate';
import type { CursorLayer, ImageLayer, Layer, ShapeLayer, TextLayer } from './schema';
import { shapeTrim } from './shapes';
import { caretRegion, textAnimReach } from './textAnim';

/** Antialiasing fringe around drawn edges, in canvas pixels. */
export const AA_PAD = 2;
/** Safety margin around measured glyph boxes, as a fraction of the font size. */
export const GLYPH_PAD = 0.06;
/** Canvas default miterLimit: a sharp corner's miter can reach miterLimit × lineWidth / 2 from the path. */
export const MITER_LIMIT = 10;

const ARROW_W = Math.max(...CURSOR_ARROW.map((p) => p[0]));
const ARROW_H = Math.max(...CURSOR_ARROW.map((p) => p[1]));

const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/**
 * Ink of a text layer in its layer box at layer-local time `local`, plus that box (lines laid out exactly like
 * drawText) and the largest blur of each blurring text-animator phase (layer px).
 */
function textInk(ctx: Ctx2D, layer: TextLayer, local: number): { ink: Box; box: { w: number; h: number }; blurs: number[] } {
  ctx.save();
  ctx.font = fontString(layer);
  setLetterSpacing(ctx, layer.letterSpacing);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lines = layer.content.split('\n').map((text) => {
    if (!lineIsRtl(text)) return { text, m: ctx.measureText(text) };
    ctx.direction = 'rtl';
    const m = ctx.measureText(text);
    ctx.direction = 'inherit';
    return { text, m };
  });
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
  // A running text animator moves units up/down by up to |distance| (more when the easing overshoots), can grow them
  // past full size (an overshooting "Grow"; every unit scales about a point inside the text box) and draws the caret.
  const reach = textAnimReach(layer, local);
  const grow = (reach.scale - 1) * Math.max(box.w, box.h);
  ink = inflateBox(ink, grow, grow + reach.scale * reach.dy);
  if (reach.caret) ink = unionBox(ink, caretRegion(layer, box));
  return { ink, box, blurs: reach.blurs };
}

/** Sharp corners whose miter can stick out further than half the line width. */
function hasAcuteCorners(layer: ShapeLayer): boolean {
  return layer.shape === 'triangle' || layer.shape === 'star' || layer.shape === 'polygon';
}

function signedBox(w: number, h: number): Box {
  return { x0: Math.min(0, w), y0: Math.min(0, h), x1: Math.max(0, w), y1: Math.max(0, h) };
}

/** Square line ends show (open line or trimmed outline): a cap corner sits half the width diagonally past the end. */
function squareEnds(layer: ShapeLayer): boolean {
  return layer.lineCap === 'square' && (layer.shape === 'line' || shapeTrim(layer).kind === 'dash');
}

function shapeInk(layer: ShapeLayer): Box {
  const box = signedBox(layer.width, layer.height);
  if (layer.strokeWidth <= 0) return box;
  // Rects (90° miters reach the corner of the box grown by half the width), ellipses and lines: × 1; square ends: × √2.
  const reach = hasAcuteCorners(layer) ? MITER_LIMIT : squareEnds(layer) ? Math.SQRT2 : 1;
  return inflateBox(box, (layer.strokeWidth / 2) * reach);
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
    const R = r.radius;
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
      let blurs: number[];
      ({ ink, box, blurs } = textInk(ctx, layer, local));
      // Per-unit blur of a "Blur" text animator: up to that blur × k canvas px, spreading 3× (chained blurs add up).
      for (const b of blurs) extra += blurMargin(b * scale * Math.abs(layer.scale));
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
