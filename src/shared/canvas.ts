// One way to create every canvas that renderFrame draws into (export page, offscreens, PNG stills, tests).
// alpha:true keeps Chromium on grayscale text antialiasing everywhere: an opaque ({alpha:false}) canvas switches text to
// LCD subpixel AA, which then differs from transparent offscreens and smears under 4:2:0 video. renderFrame always
// paints an opaque background, so frames stay opaque. willReadFrequently keeps the canvas on the CPU rasteriser
// (deterministic, fast getImageData).
export const RENDER_CONTEXT_OPTIONS: CanvasRenderingContext2DSettings = { alpha: true, willReadFrequently: true };

export function createRenderCanvas(width: number, height: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, ctx: canvas.getContext('2d', RENDER_CONTEXT_OPTIONS)! };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d', RENDER_CONTEXT_OPTIONS)! };
}

export type RenderCanvas = ReturnType<typeof createRenderCanvas>;

/**
 * Reusable offscreen canvases for renderFrame (transitions, layer isolation). Owned by the caller (the preview, the
 * render page) and passed in RenderResources, so renderFrame itself keeps no module-level state.
 * - acquire(w, h) returns a canvas that is distinct from every other canvas acquired in the same frame, sized w×h and
 *   fully reset (transform, alpha, composite, filter, shadow, clip, pixels), so output never depends on earlier frames;
 * - releaseAll() is called by renderFrame when the frame is done; sizes not used in that frame are dropped.
 */
export interface CanvasPool {
  acquire: (width: number, height: number) => RenderCanvas;
  releaseAll: () => void;
}

export function resetContext(ctx: RenderCanvas['ctx']) {
  const c = ctx as RenderCanvas['ctx'] & { reset?: () => void };
  if (typeof c.reset === 'function') {
    c.reset();
    return;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

export function createCanvasPool(): CanvasPool {
  const free = new Map<string, RenderCanvas[]>();
  const used: [string, RenderCanvas][] = [];
  return {
    acquire(width, height) {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      const key = `${w}x${h}`;
      const entry = free.get(key)?.pop() ?? createRenderCanvas(w, h);
      resetContext(entry.ctx);
      used.push([key, entry]);
      return entry;
    },
    releaseAll() {
      const keys = new Set(used.map(([k]) => k));
      for (const k of [...free.keys()]) if (!keys.has(k)) free.delete(k);
      for (const [k, e] of used) {
        const list = free.get(k) ?? [];
        list.push(e);
        free.set(k, list);
      }
      used.length = 0;
    },
  };
}
