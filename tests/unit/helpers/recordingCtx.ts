// A fake 2D context that records every call/assignment, for testing renderFrame's draw calls in Node (no canvas there).
// Pixel-level tests belong in Playwright (see browserImport in tests/e2e/helpers.ts).
import type { Ctx2D, RenderResources } from '../../../src/shared/renderFrame';

export interface Recorder {
  ctx: Ctx2D;
  log: string[];
  /** Sub-recorders created through `createCanvas` (offscreens/scratch canvases), in creation order. */
  children: Recorder[];
  /** Pass as `resources.canvasPool` so offscreen drawing is recorded too (each acquire = a new child recorder). */
  pool: NonNullable<RenderResources['canvasPool']>;
  /** Number of releaseAll() calls (renderFrame should call it once per frame). */
  releases: () => number;
  reset: () => void;
}

export function recordingCtx(width = 1920, height = 1080, name = 'main'): Recorder {
  const log: string[] = [];
  const children: Recorder[] = [];
  const target: Record<string, unknown> = {};
  const canvas = { width, height, name };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: s.length * 10 });
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
        return (...args: unknown[]) => {
          log.push(`${prop}(${JSON.stringify(args)})`);
          return { addColorStop: (o: number, c: string) => log.push(`addColorStop(${o},${JSON.stringify(c)})`) };
        };
      if (prop in t) return t[prop];
      return (...args: unknown[]) => log.push(`${prop}(${JSON.stringify(args, (_k, v) => (v && typeof v === 'object' && 'name' in v && 'width' in v ? `<canvas ${v.name}>` : v))})`);
    },
    set(t, prop: string, v) {
      t[prop] = v;
      log.push(`${prop}=${JSON.stringify(v)}`);
      return true;
    },
  });
  let releases = 0;
  const rec: Recorder = {
    ctx: ctx as unknown as Ctx2D,
    log,
    children,
    pool: {
      acquire: (w, h) => {
        const child = recordingCtx(w, h, `${name}.${children.length}`);
        children.push(child);
        return { canvas: child.ctx.canvas as unknown as OffscreenCanvas, ctx: child.ctx };
      },
      releaseAll: () => void releases++,
    },
    releases: () => releases,
    reset: () => {
      log.length = 0;
      children.length = 0;
      for (const k of Object.keys(target)) delete target[k];
    },
  };
  return rec;
}
