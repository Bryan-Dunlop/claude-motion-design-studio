// The one drawing function used by BOTH the editor preview and the MP4 export.
// Output depends only on (project, time, scale, loaded resources): no clocks, no randomness.
import { applyEasing } from './easing';
import { resolveLayer } from './interpolate';
import type { CanvasPool } from './canvas';
import type { CursorLayer, ImageLayer, Layer, Project, Scene, ShapeLayer, TextLayer } from './schema';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface RenderResources {
  /** assetId -> decoded image (absent = missing asset placeholder). */
  images: Map<string, CanvasImageSource>;
  /**
   * Offscreen/scratch canvases (transitions, layer isolation), owned by the caller. When absent, use fresh canvases
   * from createRenderCanvas. renderFrame calls canvasPool.releaseAll() when a frame is finished and keeps no
   * module-level canvas cache.
   */
  canvasPool?: CanvasPool;
}

const EMPTY_RESOURCES: RenderResources = { images: new Map() };

/** Scenes visible at `t`, in z-order (array order). */
export function activeScenes(project: Project, t: number): Scene[] {
  return project.scenes.filter((s) => t >= s.start && t < s.start + s.duration);
}

export function isLayerActive(layer: Layer, sceneLocal: number): boolean {
  return sceneLocal >= layer.start && sceneLocal < layer.start + layer.duration;
}

export function fontString(layer: Pick<TextLayer, 'fontWeight' | 'fontSize' | 'fontFamily'>): string {
  const fam = /[\s,'"]/.test(layer.fontFamily) && !layer.fontFamily.includes(',') ? `"${layer.fontFamily}"` : layer.fontFamily;
  return `${layer.fontWeight} ${layer.fontSize}px ${fam}, sans-serif`;
}

interface TextMetricsBox {
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

function setLetterSpacing(ctx: Ctx2D, px: number) {
  const c = ctx as Ctx2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${px}px`;
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

export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// ---------------------------------------------------------------- cursor

const CURSOR_PRESS_SEC = 0.15;
export const CURSOR_RIPPLE_SEC = 0.5;

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

function drawCursor(ctx: Ctx2D, layer: CursorLayer, local: number) {
  const pos = cursorPosition(layer, local);
  // Ripples (drawn under the pointer).
  for (const click of layer.clicks) {
    const dt = local - click.time;
    if (dt < 0 || dt >= CURSOR_RIPPLE_SEC) continue;
    const p = dt / CURSOR_RIPPLE_SEC;
    const eased = applyEasing({ type: 'easeOut' }, p);
    ctx.save();
    ctx.globalAlpha *= 1 - p;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, layer.size * (0.2 + 1.3 * eased) * layer.scale, 0, Math.PI * 2);
    ctx.fillStyle = layer.rippleColor;
    ctx.fill();
    ctx.restore();
  }
  let press = 1;
  for (const click of layer.clicks) {
    const dt = local - click.time;
    if (dt >= 0 && dt < CURSOR_PRESS_SEC) press = Math.min(press, 1 - 0.18 * Math.sin((dt / CURSOR_PRESS_SEC) * Math.PI));
  }
  const s = (layer.size / 24) * layer.scale * press;
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.scale(s, s);
  ctx.beginPath();
  // Classic arrow pointer, tip at (0,0), drawn in a 24-unit box.
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 25);
  ctx.lineTo(6, 19.5);
  ctx.lineTo(10, 28.5);
  ctx.lineTo(14, 26.8);
  ctx.lineTo(10.2, 18);
  ctx.lineTo(18, 18);
  ctx.closePath();
  ctx.fillStyle = layer.color;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.8;
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
    const x = layer.align === 'left' ? 0 : layer.align === 'center' ? (m.w - line.width) / 2 : m.w - line.width;
    ctx.fillText(line.text, x, i * m.lineHeightPx + m.lineHeightPx / 2);
  });
}

function roundRectPath(ctx: Ctx2D, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
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
    ctx.ellipse(layer.width / 2, layer.height / 2, layer.width / 2, layer.height / 2, 0, 0, Math.PI * 2);
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

export function drawLayer(ctx: Ctx2D, rawLayer: Layer, layerLocal: number, res: RenderResources) {
  const layer = resolveLayer(rawLayer, layerLocal);
  if (layer.opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha *= Math.min(1, Math.max(0, layer.opacity));
  if (layer.type === 'cursor') {
    drawCursor(ctx, layer, layerLocal);
  } else {
    const box = layerBox(ctx, layer);
    const m = layerMatrix(layer, box);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (layer.type === 'text') drawText(ctx, layer);
    else if (layer.type === 'shape') drawShape(ctx, layer);
    else drawImage(ctx, layer, res);
  }
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
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  for (const scene of activeScenes(project, timeSec)) {
    const sceneLocal = timeSec - scene.start;
    for (const layer of scene.layers) {
      if (!layer.visible || !isLayerActive(layer, sceneLocal)) continue;
      drawLayer(ctx, layer, sceneLocal - layer.start, resources);
    }
  }
  ctx.restore();
}

export function frameCount(project: Project): number {
  return Math.max(1, Math.round(project.settings.durationSec * project.settings.fps));
}

export function frameTime(project: Project, frame: number): number {
  return frame / project.settings.fps;
}
