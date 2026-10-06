// The one drawing function used by BOTH the editor preview and the MP4 export.
// Output depends only on (project, time, scale, loaded resources): no clocks, no randomness, no state between frames.
import { createRenderCanvas, type CanvasPool, type RenderCanvas } from './canvas';
import { applyEffects, clampResolved, effectRegion, influenceRegion, layerEffects, type LayerEffects } from './effects';
import {
  CURSOR_ARROW,
  CURSOR_OUTLINE,
  cursorPosition,
  cursorPress,
  cursorRipples,
  fontString,
  intersectBox,
  isEmptyBox,
  layerBox,
  layerMatrix,
  lineX,
  measureText,
  roundOutBox,
  setLetterSpacing,
  translateBox,
  unionBox,
  type Box,
  type Ctx2D,
} from './geometry';
import { inkBoundsResolved } from './inkBounds';
import { resolveLayer } from './interpolate';
import type { CursorLayer, ImageLayer, Layer, Project, Scene, ShapeLayer, TextLayer } from './schema';
import { blurPad, directionalLayout, dissolve, TRANSITION_BLUR, zoomFactor, type DissolveSource } from './transitionDraw';
import { partnerLocalTime, planTransitions, type TransitionPlan } from './transitions';

// Geometry used to live here; re-exported so existing imports keep working.
export {
  applyMatrix,
  cursorPosition,
  CURSOR_RIPPLE_SEC,
  fontString,
  invertMatrix,
  layerBox,
  layerMatrix,
  measureText,
  type Ctx2D,
  type Matrix,
} from './geometry';

export interface RenderResources {
  /** assetId -> decoded image (absent = missing asset placeholder). */
  images: Map<string, CanvasImageSource>;
  /**
   * Offscreen/scratch canvases (transitions, layer isolation), owned by the caller. When absent, use fresh canvases
   * from createRenderCanvas. renderFrame calls canvasPool.releaseAll() when a frame is finished and keeps no
   * module-level canvas cache.
   */
  canvasPool?: CanvasPool;
  /** Canvas factory used when there is no pool (unit tests inject recording canvases). Defaults to createRenderCanvas. */
  createCanvas?: (width: number, height: number) => RenderCanvas;
}

const EMPTY_RESOURCES: RenderResources = { images: new Map() };

/** A canvas for this frame: distinct from every other canvas acquired before releaseAll(). */
function acquire(res: RenderResources, width: number, height: number): RenderCanvas {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (res.canvasPool) return res.canvasPool.acquire(w, h);
  return (res.createCanvas ?? createRenderCanvas)(w, h);
}

/** Scratch sizes are rounded up so pooled canvases get reused while a layer moves (extra area stays transparent). */
const scratchSize = (n: number) => Math.ceil(n / 64) * 64;

/** Scenes visible at `t`, in z-order (array order). */
export function activeScenes(project: Project, t: number): Scene[] {
  return project.scenes.filter((s) => isSceneActive(s, t));
}

function isSceneActive(s: Scene, t: number): boolean {
  return t >= s.start && t < s.start + s.duration;
}

export function isLayerActive(layer: Layer, sceneLocal: number): boolean {
  return sceneLocal >= layer.start && sceneLocal < layer.start + layer.duration;
}

// ---------------------------------------------------------------- cursor

function drawCursor(ctx: Ctx2D, layer: CursorLayer, local: number) {
  const pos = cursorPosition(layer, local);
  // Ripples (drawn under the pointer).
  for (const ripple of cursorRipples(layer, local)) {
    ctx.save();
    ctx.globalAlpha *= ripple.alpha;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, ripple.radius, 0, Math.PI * 2);
    ctx.fillStyle = layer.rippleColor;
    ctx.fill();
    ctx.restore();
  }
  const s = (layer.size / 24) * layer.scale * cursorPress(layer, local);
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.scale(s, s);
  ctx.beginPath();
  CURSOR_ARROW.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = layer.color;
  ctx.lineJoin = 'round';
  ctx.lineWidth = CURSOR_OUTLINE;
  ctx.strokeStyle = isDark(layer.color) ? '#ffffff' : '#000000';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function isDark(hex: string): boolean {
  const s = hex.replace('#', '');
  if (s.length < 6) return true;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 < 140;
}

// ---------------------------------------------------------------- layer drawing

function drawText(ctx: Ctx2D, layer: TextLayer) {
  const m = measureText(ctx, layer);
  ctx.font = fontString(layer);
  setLetterSpacing(ctx, layer.letterSpacing);
  ctx.fillStyle = layer.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  m.lines.forEach((line, i) => {
    ctx.fillText(line.text, lineX(layer.align, m.w, line.width), i * m.lineHeightPx + m.lineHeightPx / 2);
  });
}

function roundRectPath(ctx: Ctx2D, w: number, h: number, r: number) {
  // Never negative: arcTo throws on a negative radius (e.g. a size animated past 0 by a spring).
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(rr, 0);
  ctx.arcTo(w, 0, w, h, rr);
  ctx.arcTo(w, h, 0, h, rr);
  ctx.arcTo(0, h, 0, 0, rr);
  ctx.arcTo(0, 0, w, 0, rr);
  ctx.closePath();
}

function drawShape(ctx: Ctx2D, layer: ShapeLayer) {
  if (layer.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(layer.width / 2, layer.height / 2, Math.abs(layer.width / 2), Math.abs(layer.height / 2), 0, 0, Math.PI * 2);
  } else {
    roundRectPath(ctx, layer.width, layer.height, layer.cornerRadius);
  }
  ctx.fillStyle = layer.fill;
  ctx.fill();
  if (layer.strokeWidth > 0) {
    ctx.lineWidth = layer.strokeWidth;
    ctx.strokeStyle = layer.stroke;
    ctx.stroke();
  }
}

function drawImage(ctx: Ctx2D, layer: ImageLayer, res: RenderResources) {
  const img = res.images.get(layer.assetId);
  if (img) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, layer.width, layer.height);
    return;
  }
  // Missing asset placeholder.
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, 0, layer.width, layer.height);
  ctx.strokeStyle = '#ff5c5c';
  ctx.lineWidth = Math.max(2, layer.width / 200);
  ctx.strokeRect(0, 0, layer.width, layer.height);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(layer.width, layer.height);
  ctx.moveTo(layer.width, 0);
  ctx.lineTo(0, layer.height);
  ctx.stroke();
}

/** The layer's own drawing (no opacity, no effects), relative to the current transform. */
function drawLayerBody(ctx: Ctx2D, layer: Layer, local: number, res: RenderResources) {
  if (layer.type === 'cursor') {
    drawCursor(ctx, layer, local);
    return;
  }
  const box = layerBox(ctx, layer);
  const m = layerMatrix(layer, box);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  if (layer.type === 'text') drawText(ctx, layer);
  else if (layer.type === 'shape') drawShape(ctx, layer);
  else drawImage(ctx, layer, res);
}

/**
 * Layers that paint with more than one draw call. A shadow, blur or blend mode applied per call would be wrong for them
 * (a stroke's shadow lands inside its own fill, the cursor's shadow darkens its own arrow), so with an effect they are
 * drawn once into a scratch canvas and composited in one go.
 */
function isMultiDraw(layer: Layer, res: RenderResources): boolean {
  switch (layer.type) {
    case 'shape':
      return layer.strokeWidth > 0;
    case 'text':
      return layer.content.includes('\n') || layer.strokeWidth > 0;
    case 'cursor':
      return true;
    case 'image':
      return !res.images.has(layer.assetId);
  }
}

/** Clip to a canvas-pixel box (whole pixels), then put the view transform back. */
function clipToBox(ctx: Ctx2D, box: Box, scale: number, ox: number, oy: number) {
  const b = roundOutBox(box);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  ctx.clip();
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
}

/**
 * Draw one layer at layer-local time. `scale` maps project px to canvas px; (ox, oy) is the canvas position of the
 * project origin (non-zero while a transition moves the scene). The context's transform must be that mapping.
 */
export function drawLayer(ctx: Ctx2D, rawLayer: Layer, layerLocal: number, res: RenderResources, scale: number, ox = 0, oy = 0) {
  const layer = clampResolved(resolveLayer(rawLayer, layerLocal));
  if (layer.opacity <= 0) return;
  const fx = layerEffects(layer, scale);
  if (!fx.active) {
    // No effects: exactly the v1 drawing (per-call opacity).
    ctx.save();
    ctx.globalAlpha *= Math.min(1, Math.max(0, layer.opacity));
    drawLayerBody(ctx, layer, layerLocal, res);
    ctx.restore();
    return;
  }
  const ink = translateBox(inkBoundsResolved(layer, layerLocal, scale, ctx), ox, oy);
  if (isMultiDraw(layer, res)) drawIsolated(ctx, layer, layerLocal, res, scale, ox, oy, fx, ink);
  else drawDirect(ctx, layer, layerLocal, res, scale, ox, oy, fx, ink);
}

/** Single-draw layer: the effect goes straight onto its one draw call. */
function drawDirect(ctx: Ctx2D, layer: Layer, local: number, res: RenderResources, scale: number, ox: number, oy: number, fx: LayerEffects, ink: Box) {
  ctx.save();
  // Chromium filters the whole clip region: keep a filtered draw to the area it can actually change.
  if (fx.blur > 0) clipToBox(ctx, effectRegion(ink, fx), scale, ox, oy);
  applyEffects(ctx, fx);
  ctx.globalAlpha *= layer.opacity;
  drawLayerBody(ctx, layer, local, res);
  ctx.restore();
}

/**
 * Multi-draw layer with an effect: draw it plainly (source-over, no shadow/filter, opacity 1) into a scratch canvas
 * bounded by its ink, then composite that once at identity with the shadow, filter, blend mode and opacity.
 */
function drawIsolated(ctx: Ctx2D, layer: Layer, local: number, res: RenderResources, scale: number, ox: number, oy: number, fx: LayerEffects, ink: Box) {
  const frame: Box = { x0: 0, y0: 0, x1: ctx.canvas.width, y1: ctx.canvas.height };
  // Only the part of the layer that can reach the canvas (through blur or a shadow offset) needs drawing.
  const content = roundOutBox(intersectBox(ink, influenceRegion(frame, fx)));
  if (isEmptyBox(content)) return;
  const region = effectRegion(content, fx);
  // Scratch = the content plus the visible part of its blur/shadow margin.
  const area = roundOutBox(unionBox(content, intersectBox(region, frame)));
  const scratch = acquire(res, scratchSize(area.x1 - area.x0), scratchSize(area.y1 - area.y0));
  scratch.ctx.setTransform(scale, 0, 0, scale, ox - area.x0, oy - area.y0);
  drawLayerBody(scratch.ctx, layer, local, res);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (fx.blur > 0) {
    const c = roundOutBox(region);
    ctx.beginPath();
    ctx.rect(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0);
    ctx.clip();
  }
  applyEffects(ctx, fx);
  ctx.globalAlpha *= layer.opacity;
  ctx.drawImage(scratch.canvas, area.x0, area.y0);
  ctx.restore();
}

// ---------------------------------------------------------------- scenes & transitions

function drawSceneBackground(ctx: Ctx2D, project: Project, scene: Scene) {
  if (!scene.background) return;
  ctx.save();
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, project.settings.width, project.settings.height);
  ctx.restore();
}

function drawSceneLayers(ctx: Ctx2D, scene: Scene, sceneLocal: number, res: RenderResources, scale: number, ox = 0, oy = 0) {
  for (const layer of scene.layers) {
    if (!layer.visible || !isLayerActive(layer, sceneLocal)) continue;
    drawLayer(ctx, layer, sceneLocal - layer.start, res, scale, ox, oy);
  }
}

/** Draw a scene translated by (ox, oy) canvas px and clipped to `clip` (vector geometry, straight onto ctx). */
function drawSceneInSlot(ctx: Ctx2D, project: Project, scene: Scene, local: number, res: RenderResources, scale: number, ox: number, oy: number, clip: Box) {
  if (isEmptyBox(clip)) return;
  ctx.save();
  clipToBox(ctx, clip, scale, ox, oy);
  drawSceneBackground(ctx, project, scene);
  drawSceneLayers(ctx, scene, local, res, scale, ox, oy);
  ctx.restore();
}

/**
 * One side of a cross-fade: a backdrop-inclusive, opaque copy of the frame so far with `scene` drawn on top (its
 * layers zoomed about the frame centre by `zoom`). Opaque inputs keep the dissolve exact and let blend modes see the
 * real backdrop.
 */
function fadeSide(ctx: Ctx2D, project: Project, scene: Scene | null, local: number, res: RenderResources, scale: number, zoom: number): DissolveSource {
  const { width, height } = project.settings;
  const c = acquire(res, ctx.canvas.width, ctx.canvas.height).ctx;
  c.drawImage(ctx.canvas, 0, 0);
  if (scene) {
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.beginPath();
    c.rect(0, 0, width, height);
    c.clip();
    drawSceneBackground(c, project, scene);
    if (zoom === 1) drawSceneLayers(c, scene, local, res, scale);
    else {
      const zs = scale * zoom;
      const ox = ((width * scale) / 2) * (1 - zoom);
      const oy = ((height * scale) / 2) * (1 - zoom);
      c.setTransform(zs, 0, 0, zs, ox, oy);
      drawSceneLayers(c, scene, local, res, zs, ox, oy);
    }
  }
  return { canvas: c.canvas, pad: 0 };
}

/**
 * One side of the blur style: the frame so far + `scene`, rendered into a canvas padded by m ≥ 3·radius on every side
 * and pre-filled with the scene's background colour, then blurred — so the frame edges blur into that colour instead
 * of fading to transparent. The dissolve crops the frame back out at (m, m).
 */
function blurSide(ctx: Ctx2D, project: Project, scene: Scene | null, local: number, res: RenderResources, scale: number, radius: number): DissolveSource {
  const { width, height, background } = project.settings;
  const m = blurPad(radius);
  const pw = ctx.canvas.width + 2 * m;
  const ph = ctx.canvas.height + 2 * m;
  const padded = acquire(res, pw, ph);
  const c = padded.ctx;
  c.fillStyle = scene?.background ?? background;
  c.fillRect(0, 0, pw, ph);
  c.drawImage(ctx.canvas, m, m);
  if (scene) {
    c.setTransform(scale, 0, 0, scale, m, m);
    c.beginPath();
    c.rect(0, 0, width, height);
    c.clip();
    drawSceneBackground(c, project, scene);
    drawSceneLayers(c, scene, local, res, scale, m, m);
  }
  if (radius <= 0) return { canvas: padded.canvas, pad: m };
  const blurred = acquire(res, pw, ph).ctx;
  blurred.beginPath();
  blurred.rect(0, 0, pw, ph);
  blurred.clip();
  blurred.filter = `blur(${radius}px)`;
  blurred.drawImage(padded.canvas, 0, 0);
  return { canvas: blurred.canvas, pad: m };
}

/** Draw scene S transitioning in from its partner P (docs/v2-plan.md A1, "Compositing"). */
function drawTransition(ctx: Ctx2D, project: Project, t: number, plan: TransitionPlan, res: RenderResources, scale: number) {
  const { scene, partner, progress: p } = plan;
  const { type, direction } = scene.transition;
  const local = t - scene.start;
  const partnerLocal = partner ? partnerLocalTime(partner, t) : 0;
  if (type === 'slide' || type === 'push' || type === 'wipe') {
    // Straight onto the frame: blend modes see the real backdrop and text stays vector.
    const lay = directionalLayout(type, direction, p, project.settings.width * scale, project.settings.height * scale);
    if (partner) drawSceneInSlot(ctx, project, partner, partnerLocal, res, scale, lay.from.x, lay.from.y, lay.from.clip);
    drawSceneInSlot(ctx, project, scene, local, res, scale, lay.to.x, lay.to.y, lay.to.clip);
    return;
  }
  let outgoing: DissolveSource | null = null;
  let incoming: DissolveSource | null = null;
  if (type === 'blur') {
    const B = TRANSITION_BLUR * Math.max(project.settings.width, project.settings.height) * scale;
    if (p < 1) outgoing = blurSide(ctx, project, partner, partnerLocal, res, scale, p * B);
    if (p > 0) incoming = blurSide(ctx, project, scene, local, res, scale, (1 - p) * B);
  } else {
    if (p < 1) outgoing = fadeSide(ctx, project, partner, partnerLocal, res, scale, 1);
    if (p > 0) incoming = fadeSide(ctx, project, scene, local, res, scale, type === 'zoom' ? zoomFactor(p) : 1);
  }
  const temp = acquire(res, ctx.canvas.width, ctx.canvas.height);
  dissolve(temp.ctx, outgoing, incoming, p);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(temp.canvas, 0, 0);
  ctx.restore();
}

/**
 * Draw one frame of `project` at `timeSec` into ctx.
 * `scale` maps project pixels to canvas pixels (1 for export, viewport-fit * devicePixelRatio for preview).
 * Everything is vector-drawn at the target scale, so text and shapes stay crisp at any resolution.
 */
export function renderFrame(project: Project, timeSec: number, ctx: Ctx2D, scale: number, resources: RenderResources = EMPTY_RESOURCES) {
  const { width, height, background } = project.settings;
  ctx.save();
  try {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    const { plans, partners } = planTransitions(project, timeSec);
    for (const scene of project.scenes) {
      // An outgoing partner is drawn by the transition that uses it.
      if (partners.has(scene.id)) continue;
      const plan = plans.get(scene.id);
      if (plan) drawTransition(ctx, project, timeSec, plan, resources, scale);
      else if (isSceneActive(scene, timeSec)) {
        drawSceneBackground(ctx, project, scene);
        drawSceneLayers(ctx, scene, timeSec - scene.start, resources, scale);
      }
    }
  } finally {
    ctx.restore();
    resources.canvasPool?.releaseAll();
  }
}

export function frameCount(project: Project): number {
  return Math.max(1, Math.round(project.settings.durationSec * project.settings.fps));
}

export function frameTime(project: Project, frame: number): number {
  return frame / project.settings.fps;
}
