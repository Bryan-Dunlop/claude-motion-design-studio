// Scene-transition compositing helpers (docs/v2-plan.md A1). Geometry is pure; `dissolve` composites canvases it is
// given. renderFrame decides what goes into those canvases.
import type { Box, Ctx2D } from './geometry';
import type { Transition } from './schema';

/** Styles drawn straight onto the frame with a vector translate/clip (no offscreens). */
export const DIRECT_STYLES: Transition['type'][] = ['slide', 'push', 'wipe'];

/** Blur style: strongest blur, as a fraction of the frame's long edge. */
export const TRANSITION_BLUR = 0.03;
/** Zoom style: the incoming scene starts this much larger and settles to 1. */
export const ZOOM_FROM = 1.25;

export const zoomFactor = (p: number) => ZOOM_FROM + (1 - ZOOM_FROM) * p;

export interface SceneSlot {
  /** Translation of the scene, in canvas pixels. */
  x: number;
  y: number;
  /** Region of the frame the scene may paint. */
  clip: Box;
}

/**
 * Where the outgoing (`from`) and incoming (`to`) scenes go for slide / push / wipe at progress p, in a W×H frame
 * (canvas pixels). Direction = direction of travel: 'left' moves right → left, so the incoming scene enters from the
 * right edge. The boundary between the two scenes is a whole pixel and each scene's edge sits exactly on it, so there
 * is no antialiased seam.
 */
export function directionalLayout(type: 'slide' | 'push' | 'wipe', direction: Transition['direction'], p: number, W: number, H: number): { from: SceneSlot; to: SceneSlot } {
  const horizontal = direction === 'left' || direction === 'right';
  const size = horizontal ? W : H;
  // The incoming scene enters from the far edge for left/up, from the near edge for right/down.
  const fromFar = direction === 'left' || direction === 'up';
  const b = Math.round(fromFar ? (1 - p) * size : p * size);
  // Incoming offset (slide/push) puts its leading edge on b; push moves the outgoing scene along with it.
  const toOff = type === 'wipe' ? 0 : fromFar ? b : b - size;
  const fromOff = type === 'push' ? (fromFar ? b - size : b) : 0;
  const near = (lo: number, hi: number): Box => (horizontal ? { x0: lo, y0: 0, x1: hi, y1: H } : { x0: 0, y0: lo, x1: W, y1: hi });
  const toClip = fromFar ? near(b, size) : near(0, b);
  const fromClip = fromFar ? near(0, b) : near(b, size);
  const slot = (off: number, clip: Box): SceneSlot => ({ x: horizontal ? off : 0, y: horizontal ? 0 : off, clip });
  return { from: slot(fromOff, fromClip), to: slot(toOff, toClip) };
}

/** Padding (canvas px) around a frame blurred with radius r: at least ceil(3r), rounded up to 32 so canvases get reused. */
export function blurPad(r: number): number {
  return r > 0 ? Math.ceil(Math.ceil(3 * r) / 32) * 32 : 0;
}

export interface DissolveSource {
  canvas: CanvasImageSource;
  /** Offset of the frame inside a padded canvas (0 = frame-sized). */
  pad: number;
}

/**
 * Cross-fade two opaque, frame-sized images into `temp` (a cleared canvas of the frame size): the outgoing image with
 * alpha 1 − p, then the incoming one added with 'lighter' and alpha p. With opaque inputs this is an exact cross-fade
 * (no dip at the midpoint). A null side has weight 0 and is skipped.
 */
export function dissolve(temp: Ctx2D, outgoing: DissolveSource | null, incoming: DissolveSource | null, p: number) {
  const w = temp.canvas.width;
  const h = temp.canvas.height;
  const draw = (s: DissolveSource) => (s.pad ? temp.drawImage(s.canvas, s.pad, s.pad, w, h, 0, 0, w, h) : temp.drawImage(s.canvas, 0, 0));
  temp.save();
  if (outgoing && p < 1) {
    temp.globalAlpha = 1 - p;
    draw(outgoing);
  }
  if (incoming && p > 0) {
    temp.globalCompositeOperation = 'lighter';
    temp.globalAlpha = p;
    draw(incoming);
  }
  temp.restore();
}
