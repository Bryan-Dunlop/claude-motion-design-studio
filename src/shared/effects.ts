// Layer effects (blur, drop shadow, blend mode): resolved values in canvas pixels, value clamping, the device regions
// an effect paints, and applying them to a context. Pure (docs/v2-plan.md A1).
import { inflateBox, translateBox, unionBox, type Box, type Ctx2D } from './geometry';
import { parseColor } from './interpolate';
import type { BlendMode, Layer } from './schema';

export interface LayerEffects {
  /** Filter blur radius in canvas pixels (0 = none). */
  blur: number;
  /** Drop shadow in canvas pixels (screen-space offsets), or null when nothing would be drawn. */
  shadow: { color: string; blur: number; offsetX: number; offsetY: number } | null;
  composite: GlobalCompositeOperation;
  /** True when any effect changes how the layer is drawn. */
  active: boolean;
}

export const compositeOperation = (mode: BlendMode): GlobalCompositeOperation => (mode === 'normal' ? 'source-over' : mode);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Clamp resolved (animated) values to what the canvas accepts. Spring and custom-curve easings overshoot, and the
 * canvas silently ignores invalid assignments (keeping the previous value), so e.g. a blur animated 8 → 0 with a
 * spring must never reach the context as a negative number. Returns the same object when nothing needed clamping.
 */
export function clampResolved<L extends Layer>(layer: L): L {
  const fix: Record<string, number> = {};
  const range = (prop: string, lo: number, hi = Infinity) => {
    const v = (layer as unknown as Record<string, unknown>)[prop];
    if (typeof v === 'number' && (v < lo || v > hi)) fix[prop] = clamp(v, lo, hi);
  };
  range('opacity', 0, 1);
  range('blur', 0);
  range('shadowBlur', 0);
  if (layer.type === 'text' || layer.type === 'shape') range('strokeWidth', 0);
  if (layer.type === 'text') range('fontSize', 0);
  if (layer.type === 'shape') {
    range('trimStart', 0, 1);
    range('trimEnd', 0, 1);
    range('cornerRadius', 0);
    range('innerRadius', 0, 1);
  }
  return Object.keys(fix).length ? { ...layer, ...fix } : layer;
}

/**
 * Effects of a resolved layer drawn at render scale `scale`. Sizes are in project pixels and scale with the layer:
 * k = scale × |layer.scale| (like CSS / After Effects), so a shadow keeps its look when the layer grows or shrinks.
 */
export function layerEffects(layer: Layer, scale: number): LayerEffects {
  const k = scale * Math.abs(layer.scale);
  const blur = layer.blur * k > 1e-3 ? layer.blur * k : 0;
  const sBlur = layer.shadowBlur * k;
  const dx = layer.shadowOffsetX * k;
  const dy = layer.shadowOffsetY * k;
  // The canvas draws no shadow without blur or offset; skip it so such layers keep the plain path.
  const shadowOn = layer.shadow && parseColor(layer.shadowColor)[3] > 0 && (sBlur > 1e-3 || Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3);
  const composite = compositeOperation(layer.blendMode);
  return {
    blur,
    shadow: shadowOn ? { color: layer.shadowColor, blur: sBlur, offsetX: dx, offsetY: dy } : null,
    composite,
    active: blur > 0 || shadowOn || composite !== 'source-over',
  };
}

/** Set the effect state on a context (inside the caller's save/restore). */
export function applyEffects(ctx: Ctx2D, fx: LayerEffects) {
  if (fx.composite !== 'source-over') ctx.globalCompositeOperation = fx.composite;
  if (fx.shadow) {
    ctx.shadowColor = fx.shadow.color;
    ctx.shadowBlur = fx.shadow.blur;
    ctx.shadowOffsetX = fx.shadow.offsetX;
    ctx.shadowOffsetY = fx.shadow.offsetY;
  }
  if (fx.blur > 0) ctx.filter = `blur(${fx.blur}px)`;
}

/** A filter blur of radius r is a Gaussian with σ = r: content spreads by up to 3σ (beyond that it rounds to 0). */
export const blurMargin = (r: number) => (r > 0 ? Math.ceil(3 * r) : 0);

/** A canvas shadow blur b is a Gaussian with σ = b / 2. */
export const shadowMargin = (b: number) => (b > 0 ? Math.ceil(1.5 * b) : 0);

/** Canvas region painted when content covering `ink` is drawn with these effects (the blurred content and its shadow). */
export function effectRegion(ink: Box, fx: LayerEffects): Box {
  const body = inflateBox(ink, blurMargin(fx.blur));
  if (!fx.shadow) return body;
  return unionBox(body, inflateBox(translateBox(body, fx.shadow.offsetX, fx.shadow.offsetY), shadowMargin(fx.shadow.blur)));
}

/** Region of content that can change pixels inside `area` when drawn with these effects. */
export function influenceRegion(area: Box, fx: LayerEffects): Box {
  const m = blurMargin(fx.blur);
  const direct = inflateBox(area, m);
  if (!fx.shadow) return direct;
  return unionBox(direct, inflateBox(translateBox(area, -fx.shadow.offsetX, -fx.shadow.offsetY), m + shadowMargin(fx.shadow.blur)));
}

/** Drop-shadow values set when the shadow is first switched on (sized for the frame, so they look right at once). */
export function shadowDefaults(settings: { width: number; height: number }) {
  const short = Math.min(settings.width, settings.height);
  return { shadowColor: '#00000040', shadowOffsetY: Math.round(0.0075 * short), shadowBlur: Math.round(0.022 * short) };
}
