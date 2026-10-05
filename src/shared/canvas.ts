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
