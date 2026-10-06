// Pure maths for the editor's snapping, guides, marquee selection and hit-testing (no DOM, no store), so it can be
// unit-tested. Preview units are project pixels; the timeline works in seconds.
import type { Project } from '../shared/schema';

export type Pt = readonly [number, number];

/** Axis-aligned box. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Snapping distance in screen pixels (preview and timeline). */
export const SNAP_PX = 8;

export function boundsOf(points: readonly Pt[]): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

/** Box spanned by two corners in any order (a marquee). */
export function boxFromPoints(a: Pt, b: Pt): Box {
  return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), right: Math.max(a[0], b[0]), bottom: Math.max(a[1], b[1]) };
}

/** Left, centre, right. */
export const edgesX = (b: Box): number[] => [b.left, (b.left + b.right) / 2, b.right];
/** Top, middle, bottom. */
export const edgesY = (b: Box): number[] => [b.top, (b.top + b.bottom) / 2, b.bottom];

// ---------------------------------------------------------------- 1-D snapping (both axes and the timeline)

export interface AxisSnap {
  /** Add this to the moving positions to put the snapped one exactly on the target. */
  delta: number;
  target: number;
}

/**
 * The closest (moving position → target) pair within `threshold`, or null. Ties keep the earlier moving position and
 * the earlier target, so callers list their preferred candidates first.
 */
export function snapAxis(moving: readonly number[], targets: readonly number[], threshold: number): AxisSnap | null {
  let best: AxisSnap | null = null;
  let bestDist = Infinity;
  for (const m of moving) {
    for (const t of targets) {
      const d = Math.abs(t - m);
      if (d <= threshold && d < bestDist) {
        best = { delta: t - m, target: t };
        bestDist = d;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- preview move snapping

export interface MoveTargets {
  x: number[];
  y: number[];
}

/**
 * What a moved selection snaps to: the frame edges and centre, the other visible layers' bounds (left/centre/right,
 * top/middle/bottom) and, when guides are shown, the safe-box edges.
 */
export function moveTargets(frame: { width: number; height: number }, others: readonly Box[], safe: Box | null): MoveTargets {
  const x = [0, frame.width / 2, frame.width];
  const y = [0, frame.height / 2, frame.height];
  for (const b of others) {
    x.push(...edgesX(b));
    y.push(...edgesY(b));
  }
  if (safe) {
    x.push(safe.left, safe.right);
    y.push(safe.top, safe.bottom);
  }
  return { x, y };
}

export interface MoveSnap {
  dx: number;
  dy: number;
  /** Target positions the snapped selection touches (where the magenta guide lines go). */
  guidesX: number[];
  guidesY: number[];
}

/**
 * Snap a move by (dx, dy) of a selection whose bounds were `start` when the drag began. Each axis snaps on its own
 * when one of its three edges comes within `threshold` of a target; a locked axis (Shift-constrained) never snaps.
 */
export function snapMove(start: Box, dx: number, dy: number, targets: MoveTargets, threshold: number, lock: { x?: boolean; y?: boolean } = {}): MoveSnap {
  const axis = (edges: number[], d: number, ts: number[], locked?: boolean) => {
    if (locked) return { d, guides: [] as number[] };
    const moved = edges.map((e) => e + d);
    const s = snapAxis(moved, ts, threshold);
    if (!s) return { d, guides: [] as number[] };
    const snapped = moved.map((e) => e + s.delta);
    const guides = [...new Set(ts.filter((t) => snapped.some((e) => Math.abs(e - t) < 1e-6)))];
    return { d: d + s.delta, guides };
  };
  const x = axis(edgesX(start), dx, targets.x, lock.x);
  const y = axis(edgesY(start), dy, targets.y, lock.y);
  return { dx: x.d, dy: y.d, guidesX: x.guides, guidesY: y.guides };
}

// ---------------------------------------------------------------- guides overlay

export interface SafeArea {
  box: Box;
  kind: 'reels' | 'title';
  label: string;
  tip: string;
}

/** 9:16 frames (within 1%). */
export function isVertical916(width: number, height: number): boolean {
  return Math.abs(width / height - 9 / 16) < 0.01;
}

/**
 * The one safe box the Guides overlay shows: for 9:16 the area Reels/TikTok leave free of their buttons and captions
 * (top 14%, bottom 35%, sides 6%), otherwise the classic 90% title-safe box.
 */
export function safeArea(width: number, height: number): SafeArea {
  if (isVertical916(width, height))
    return {
      box: { left: 0.06 * width, top: 0.14 * height, right: 0.94 * width, bottom: 0.65 * height },
      kind: 'reels',
      label: 'Reels/TikTok UI',
      tip: 'Keep text and logos inside this box: Reels and TikTok cover the rest with their buttons and captions.',
    };
  return {
    box: { left: 0.05 * width, top: 0.05 * height, right: 0.95 * width, bottom: 0.95 * height },
    kind: 'title',
    label: 'Title safe',
    tip: 'Keep text inside this box (90% of the frame) so no screen or player crops it.',
  };
}

/** Centre lines and rule-of-thirds lines. */
export function guideLines(width: number, height: number): { x: number[]; y: number[]; centreX: number; centreY: number } {
  return { x: [width / 3, (2 * width) / 3], y: [height / 3, (2 * height) / 3], centreX: width / 2, centreY: height / 2 };
}

// ---------------------------------------------------------------- hit-testing and marquee

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

/** Even-odd rule (works for any simple polygon). */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the polygon or within `pad` of its outline. */
export function hitPolygon(p: Pt, poly: readonly Pt[], pad: number): boolean {
  if (pointInPolygon(p, poly)) return true;
  return poly.some((a, i) => distToSegment(p, a, poly[(i + 1) % poly.length]) <= pad);
}

/** Does a convex polygon overlap an axis-aligned box? (separating axis test) */
export function polygonIntersectsBox(poly: readonly Pt[], box: Box): boolean {
  if (poly.length === 0) return false;
  const b = boundsOf(poly);
  if (b.right < box.left || b.left > box.right || b.bottom < box.top || b.top > box.bottom) return false;
  const corners: Pt[] = [
    [box.left, box.top],
    [box.right, box.top],
    [box.right, box.bottom],
    [box.left, box.bottom],
  ];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    const nx = -(c[1] - a[1]);
    const ny = c[0] - a[0];
    if (nx === 0 && ny === 0) continue;
    const proj = (q: Pt) => q[0] * nx + q[1] * ny;
    const pp = poly.map(proj);
    const bp = corners.map(proj);
    if (Math.max(...pp) < Math.min(...bp) || Math.max(...bp) < Math.min(...pp)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- timeline snapping

export interface TimelineExclude {
  /** The scene being dragged: its own start/end are not targets. */
  sceneId?: string;
  /** Layers whose bar edges are not targets (the ones being moved or trimmed). */
  layerBars?: ReadonlySet<string>;
  /** Layers whose keyframes and cursor clicks are not targets (they move with the drag). */
  layerContent?: ReadonlySet<string>;
  /** Keyframes being dragged. */
  keyIds?: ReadonlySet<string>;
  /** Audio clips being dragged. */
  clipIds?: ReadonlySet<string>;
}

/**
 * Absolute times (seconds) a dragged bar edge, clip edge, scene edge or keyframe snaps to: the playhead, the project
 * start and end, scene boundaries, the other layer bars of the scene shown in the timeline (`sceneId`), their
 * keyframes and cursor clicks, and the audio clips' edges. Sorted, without duplicates.
 */
export function timelineTargets(project: Project, opts: { playhead: number | null; sceneId: string | null; exclude?: TimelineExclude }): number[] {
  const ex = opts.exclude ?? {};
  const out: number[] = [0, project.settings.durationSec];
  if (opts.playhead !== null) out.push(opts.playhead);
  for (const s of project.scenes) {
    if (s.id !== ex.sceneId) out.push(s.start, s.start + s.duration);
  }
  const shown = project.scenes.find((s) => s.id === opts.sceneId);
  if (shown) {
    for (const l of shown.layers) {
      const abs = shown.start + l.start;
      if (!ex.layerBars?.has(l.id)) out.push(abs, abs + l.duration);
      if (ex.layerContent?.has(l.id)) continue;
      for (const keys of Object.values(l.keyframes)) for (const k of keys) if (!ex.keyIds?.has(k.id)) out.push(abs + k.time);
      if (l.type === 'cursor') for (const c of l.clicks) if (c.time < l.duration && l.start + c.time < shown.duration) out.push(abs + c.time);
    }
  }
  for (const c of project.audio) if (!ex.clipIds?.has(c.id)) out.push(c.start, c.start + c.duration);
  return [...new Set(out.map((t) => Math.round(t * 1e9) / 1e9))].sort((a, b) => a - b);
}
