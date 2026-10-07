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
  /** Pass as `resources.createCanvas` (no pool): each call = a new child recorder, like `pool.acquire`. */
  createCanvas: NonNullable<RenderResources['createCanvas']>;
  reset: () => void;
}

/** State a fresh 2D context starts with (reads of never-assigned state return these instead of a function). */
const DEFAULT_STATE: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', lineWidth: 1 };

/** Radius arguments a real canvas rejects when negative (it throws IndexSizeError instead of drawing). */
const RADIUS_ARGS: Record<string, number[]> = { arc: [2], arcTo: [4], ellipse: [2, 3] };

export function recordingCtx(width = 1920, height = 1080, name = 'main'): Recorder {
  const log: string[] = [];
  const children: Recorder[] = [];
  const target: Record<string, unknown> = { ...DEFAULT_STATE };
  const canvas = { width, height, name };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: s.length * 10 });
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
        return (...args: unknown[]) => {
          log.push(`${prop}(${JSON.stringify(args)})`);
          return { addColorStop: (o: number, c: string) => log.push(`addColorStop(${JSON.stringify([o, c])})`) };
        };
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        for (const i of RADIUS_ARGS[prop] ?? [])
          if ((args[i] as number) < 0) throw new DOMException(`Failed to execute '${prop}': The radius provided (${args[i]}) is negative.`, 'IndexSizeError');
        return log.push(`${prop}(${JSON.stringify(args, (_k, v) => (v && typeof v === 'object' && 'name' in v && 'width' in v ? `<canvas ${v.name}>` : v))})`);
      };
    },
    set(t, prop: string, v) {
      t[prop] = v;
      log.push(`${prop}=${JSON.stringify(v)}`);
      return true;
    },
  });
  let releases = 0;
  const acquire = (w: number, h: number) => {
    const child = recordingCtx(w, h, `${name}.${children.length}`);
    children.push(child);
    return { canvas: child.ctx.canvas as unknown as OffscreenCanvas, ctx: child.ctx };
  };
  const rec: Recorder = {
    ctx: ctx as unknown as Ctx2D,
    log,
    children,
    pool: { acquire, releaseAll: () => void releases++ },
    releases: () => releases,
    createCanvas: acquire,
    reset: () => {
      log.length = 0;
      children.length = 0;
      for (const k of Object.keys(target)) delete target[k];
      Object.assign(target, DEFAULT_STATE);
    },
  };
  return rec;
}

// ---------------------------------------------------------------- log analysis

export type LogEntry = { call: string; args: unknown[] } | { prop: string; value: unknown };

/** `name([args])` → call; `prop=value` → assignment. */
export function parseEntry(entry: string): LogEntry {
  const call = /^(\w+)\((.*)\)$/s.exec(entry);
  if (call) return { call: call[1], args: JSON.parse(call[2]) as unknown[] };
  const i = entry.indexOf('=');
  return { prop: entry.slice(0, i), value: JSON.parse(entry.slice(i + 1)) };
}

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

export interface DrawnPoint {
  x: number;
  y: number;
  /** The draw call that painted it. */
  op: string;
}

/**
 * Replay a recorder's log with a transform stack and return every point a draw call paints, in canvas pixels:
 * path vertices (± half the line width for strokes), rect corners, text boxes (the recorder's fake metrics:
 * width 10/char, ascent 8, descent 2, textBaseline 'middle', textAlign 'left') and image corners.
 */
export function drawnPoints(log: string[]): DrawnPoint[] {
  let m: M = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  const stack: { m: M; lineWidth: number }[] = [];
  let path: { x: number; y: number; m: M }[] = [];
  const out: DrawnPoint[] = [];
  const corners = (x: number, y: number, w: number, h: number, op: string, grow = 0) => {
    for (const [cx, cy] of [[x - grow, y - grow], [x + w + grow, y - grow], [x + w + grow, y + h + grow], [x - grow, y + h + grow]]) out.push({ ...apply(m, cx, cy), op });
  };
  for (const entry of log) {
    const e = parseEntry(entry);
    if ('prop' in e) {
      if (e.prop === 'lineWidth') lineWidth = e.value as number;
      continue;
    }
    const a = e.args as number[];
    switch (e.call) {
      case 'save': stack.push({ m, lineWidth }); break;
      case 'restore': ({ m, lineWidth } = stack.pop() ?? { m, lineWidth }); break;
      case 'setTransform': m = a.slice(0, 6) as M; break;
      case 'transform': m = mul(m, a.slice(0, 6) as M); break;
      case 'translate': m = mul(m, [1, 0, 0, 1, a[0], a[1]]); break;
      case 'scale': m = mul(m, [a[0], 0, 0, a[1], 0, 0]); break;
      case 'rotate': m = mul(m, [Math.cos(a[0]), Math.sin(a[0]), -Math.sin(a[0]), Math.cos(a[0]), 0, 0]); break;
      case 'beginPath': path = []; break;
      case 'moveTo':
      case 'lineTo': path.push({ x: a[0], y: a[1], m }); break;
      case 'arcTo': path.push({ x: a[0], y: a[1], m }, { x: a[2], y: a[3], m }); break;
      case 'rect': for (const [x, y] of [[a[0], a[1]], [a[0] + a[2], a[1]], [a[0] + a[2], a[1] + a[3]], [a[0], a[1] + a[3]]]) path.push({ x, y, m }); break;
      case 'arc': for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) path.push({ x: a[0] + dx * Math.abs(a[2]), y: a[1] + dy * Math.abs(a[2]), m }); break;
      case 'ellipse':
        for (let i = 0; i < 64; i++) {
          const t = (i / 64) * Math.PI * 2;
          path.push({ x: a[0] + a[2] * Math.cos(t) * Math.cos(a[4]) - a[3] * Math.sin(t) * Math.sin(a[4]), y: a[1] + a[2] * Math.cos(t) * Math.sin(a[4]) + a[3] * Math.sin(t) * Math.cos(a[4]), m });
        }
        break;
      case 'fill': for (const p of path) out.push({ ...apply(p.m, p.x, p.y), op: 'fill' }); break;
      case 'stroke': {
        const h = lineWidth / 2;
        for (const p of path) for (const [dx, dy] of [[-h, -h], [h, -h], [h, h], [-h, h]]) out.push({ ...apply(p.m, p.x + dx, p.y + dy), op: 'stroke' });
        break;
      }
      case 'fillRect': corners(a[0], a[1], a[2], a[3], 'fillRect'); break;
      case 'strokeRect': corners(a[0], a[1], a[2], a[3], 'strokeRect', lineWidth / 2); break;
      case 'fillText':
      case 'strokeText': {
        const text = e.args[0] as string;
        corners(e.args[1] as number, (e.args[2] as number) - 8, text.length * 10, 10, e.call, e.call === 'strokeText' ? lineWidth / 2 : 0);
        break;
      }
      case 'drawImage': {
        const n = e.args.length;
        if (n === 5) corners(a[1], a[2], a[3], a[4], 'drawImage');
        else if (n === 9) corners(a[5], a[6], a[7], a[8], 'drawImage');
        else out.push({ ...apply(m, a[1], a[2]), op: 'drawImage' });
        break;
      }
    }
  }
  return out;
}

const DRAW_CALLS = new Set(['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage']);

/** Draw calls made while ctx.filter ≠ 'none' without a clip in the same or an enclosing save() scope. */
export function unclippedFilteredDraws(log: string[]): string[] {
  const stack: { filter: string; clipped: boolean }[] = [];
  let state = { filter: 'none', clipped: false };
  const bad: string[] = [];
  for (const entry of log) {
    const e = parseEntry(entry);
    if ('prop' in e) {
      if (e.prop === 'filter') state.filter = e.value as string;
      continue;
    }
    if (e.call === 'save') stack.push({ ...state });
    else if (e.call === 'restore') state = stack.pop() ?? state;
    else if (e.call === 'clip') state.clipped = true;
    else if (DRAW_CALLS.has(e.call) && state.filter !== 'none' && !state.clipped) bad.push(entry);
  }
  return bad;
}

/** A recorder and all canvases created from it, depth first. */
export function allRecorders(rec: Recorder): Recorder[] {
  return [rec, ...rec.children.flatMap(allRecorders)];
}
