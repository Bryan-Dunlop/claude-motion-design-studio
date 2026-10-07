// Snapping, guides, marquee and hit-test maths (src/app/snapping.ts).
import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  boxFromPoints,
  distToSegment,
  guideLines,
  hitPolygon,
  isVertical916,
  moveTargets,
  pointInPolygon,
  polygonIntersectsBox,
  safeArea,
  snapAxis,
  snapMove,
  timelineTargets,
  unionBox,
  type Box,
  type Pt,
} from '../../src/app/snapping';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { emptyProject } from '../../src/shared/schema';

const FRAME = { width: 1920, height: 1080 };
/** A 200×100 box with its top-left corner at (x, y). */
const box = (x: number, y: number, w = 200, h = 100): Box => ({ left: x, top: y, right: x + w, bottom: y + h });

describe('snapAxis', () => {
  it('picks the closest moving position / target pair within the threshold', () => {
    expect(snapAxis([100, 150, 200], [0, 960, 205], 8)).toEqual({ delta: 5, target: 205 });
    expect(snapAxis([100], [96, 103], 8)).toEqual({ delta: 3, target: 103 });
  });
  it('returns null when nothing is close enough; the threshold itself still snaps', () => {
    expect(snapAxis([100], [108.01], 8)).toBeNull();
    expect(snapAxis([100], [108], 8)).toEqual({ delta: 8, target: 108 });
    expect(snapAxis([], [1], 8)).toBeNull();
  });
  it('ties keep the earlier moving position and the earlier target', () => {
    expect(snapAxis([10, 20], [15], 8)).toEqual({ delta: 5, target: 15 });
    expect(snapAxis([10], [5, 15], 8)).toEqual({ delta: -5, target: 5 });
  });
});

describe('preview move snapping', () => {
  const targets = moveTargets(FRAME, [], null);

  it('targets are the frame edges and centre, other layers left/centre/right + top/middle/bottom, and the safe box', () => {
    expect(targets).toEqual({ x: [0, 960, 1920], y: [0, 540, 1080] });
    const t = moveTargets(FRAME, [box(100, 50)], { left: 96, top: 54, right: 1824, bottom: 1026 });
    expect(t.x).toEqual([0, 960, 1920, 100, 200, 300, 96, 1824]);
    expect(t.y).toEqual([0, 540, 1080, 50, 100, 150, 54, 1026]);
  });

  it('the selection centre lands exactly on the frame centre', () => {
    // Box centre starts at (500, 300); moving by (457, 236) puts it at (957, 536): 3 and 4 px from the centre lines.
    const s = snapMove(box(400, 250), 457, 236, targets, 8);
    expect(s.dx).toBe(460);
    expect(s.dy).toBe(240);
    expect(s.guidesX).toEqual([960]);
    expect(s.guidesY).toEqual([540]);
    const c = box(400 + s.dx, 250 + s.dy);
    expect((c.left + c.right) / 2).toBe(960);
    expect((c.top + c.bottom) / 2).toBe(540);
  });

  it('left/right and top/bottom edges snap to the frame edges', () => {
    const s = snapMove(box(400, 250), -395, 727, targets, 8);
    expect(s).toEqual({ dx: -400, dy: 730, guidesX: [0], guidesY: [1080] });
  });

  it('snaps to another layer\'s edge and reports every target the snapped edges touch', () => {
    const t = moveTargets(FRAME, [box(1000, 600, 300, 100)], null);
    // Selection 200 wide: its right edge (1000 + 3) snaps to the other layer's left edge; nothing else lines up.
    const s = snapMove(box(0, 0), 803, 0, t, 8);
    expect(s.dx).toBe(800);
    expect(s.guidesX).toEqual([1000]);
    // Top edge 0 is already on the frame edge: that counts as snapped (delta 0) and shows its guide.
    expect(s.guidesY).toEqual([0]);
  });

  it('nothing within the threshold: the move is unchanged and no guides show', () => {
    expect(snapMove(box(400, 250), 100, 100, targets, 8)).toEqual({ dx: 100, dy: 100, guidesX: [], guidesY: [] });
  });

  it('a locked axis (Shift-constrained move) never snaps', () => {
    const s = snapMove(box(400, 250), 457, 0, targets, 8, { y: true });
    expect(s).toEqual({ dx: 460, dy: 0, guidesX: [960], guidesY: [] });
  });

  it('the threshold is whatever the caller passes (8 screen px converted to project px)', () => {
    expect(snapMove(box(400, 250), 450, 0, targets, 8).dx).toBe(450);
    expect(snapMove(box(400, 250), 450, 0, targets, 10).dx).toBe(460);
  });
});

describe('guides', () => {
  it('9:16 shows the Reels/TikTok UI box: top 14%, bottom 35%, sides 6%', () => {
    expect(isVertical916(1080, 1920)).toBe(true);
    expect(isVertical916(2160, 3840)).toBe(true);
    const s = safeArea(1080, 1920);
    expect(s.kind).toBe('reels');
    expect(s.label).toBe('Reels/TikTok UI');
    expect(s.box.left).toBeCloseTo(64.8, 9);
    expect(s.box.right).toBeCloseTo(1015.2, 9);
    expect(s.box.top).toBeCloseTo(268.8, 9);
    expect(s.box.bottom).toBeCloseTo(1248, 9);
  });

  it('every other format shows a 90% title-safe box', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1080], [1080, 1350], [1920, 1200]]) {
      const s = safeArea(w, h);
      expect(s.kind).toBe('title');
      expect(s.box.right - s.box.left).toBeCloseTo(0.9 * w, 9);
      expect(s.box.bottom - s.box.top).toBeCloseTo(0.9 * h, 9);
      expect(s.box.left).toBeCloseTo(0.05 * w, 9);
    }
    expect(isVertical916(1080, 1350)).toBe(false);
  });

  it('centre lines and thirds', () => {
    expect(guideLines(1920, 1080)).toEqual({ x: [640, 1280], y: [360, 720], centreX: 960, centreY: 540 });
  });
});

describe('hit-testing and marquee', () => {
  const square: Pt[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const diamond: Pt[] = [[50, 0], [100, 50], [50, 100], [0, 50]];

  it('bounds and union', () => {
    expect(boundsOf(diamond)).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
    expect(unionBox([box(0, 0), box(500, 400)])).toEqual({ left: 0, top: 0, right: 700, bottom: 500 });
    expect(unionBox([])).toBeNull();
    expect(boxFromPoints([300, 20], [100, 200])).toEqual({ left: 100, top: 20, right: 300, bottom: 200 });
  });

  it('point in polygon (rotated box) and the screen-pixel pad around its outline', () => {
    expect(pointInPolygon([50, 50], diamond)).toBe(true);
    expect(pointInPolygon([5, 5], diamond)).toBe(false);
    expect(hitPolygon([5, 5], diamond, 4)).toBe(false);
    // (20, 20) is ~7.07 px from the edge (0,50)-(50,0).
    expect(hitPolygon([20, 20], diamond, 7)).toBe(false);
    expect(hitPolygon([20, 20], diamond, 7.1)).toBe(true);
    expect(hitPolygon([103, 50], square, 4)).toBe(true);
    expect(hitPolygon([105, 50], square, 4)).toBe(false);
  });

  it('distance to a segment (line shapes are hit near their stroke)', () => {
    expect(distToSegment([50, 10], [0, 0], [100, 0])).toBe(10);
    expect(distToSegment([-30, 40], [0, 0], [100, 0])).toBe(50);
    expect(distToSegment([3, 4], [0, 0], [0, 0])).toBe(5);
  });

  it('marquee overlap uses the real (rotated) outline, not its bounding box', () => {
    expect(polygonIntersectsBox(square, box(90, 90, 50, 50))).toBe(true);
    expect(polygonIntersectsBox(square, box(101, 0, 50, 50))).toBe(false);
    // The marquee touches the diamond's bounding box corner but not the diamond itself.
    expect(polygonIntersectsBox(diamond, { left: 0, top: 0, right: 20, bottom: 20 })).toBe(false);
    expect(polygonIntersectsBox(diamond, { left: 0, top: 0, right: 30, bottom: 30 })).toBe(true);
    // A marquee fully inside the polygon, and a polygon fully inside the marquee.
    expect(polygonIntersectsBox(square, box(40, 40, 5, 5))).toBe(true);
    expect(polygonIntersectsBox(diamond, box(-10, -10, 200, 200))).toBe(true);
  });
});

describe('timeline snap targets', () => {
  const base = { visible: true, locked: false, anchorX: 0.5, anchorY: 0.5, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  const project = makeProject({
    ...emptyProject(),
    settings: { durationSec: 10, aspect: '16:9', width: 1920, height: 1080, fps: 30, background: '#000000' },
    scenes: [
      {
        id: 's1', name: 'A', start: 0, duration: 4,
        layers: [
          makeLayer({ ...base, id: 'r', name: 'R', type: 'shape', start: 0.5, duration: 2, shape: 'rect', width: 10, height: 10, cornerRadius: 0, fill: '#fff', stroke: '#fff', strokeWidth: 0,
            keyframes: { x: [{ id: 'k1', time: 0.25, value: 0, easing: { type: 'linear' } }, { id: 'k2', time: 1, value: 5, easing: { type: 'linear' } }] } }),
          makeLayer({ ...base, id: 'c', name: 'C', type: 'cursor', start: 1, duration: 2, keyframes: {}, points: [], smoothing: 0, size: 20, color: '#fff', rippleColor: '#fff',
            // 2.5 is past the layer end: not drawn, so not a target.
            clicks: [{ id: 'k', time: 0.4 }, { id: 'late', time: 2.5 }] }),
        ],
      },
      { id: 's2', name: 'B', start: 4, duration: 3, layers: [] },
    ],
    assets: [],
    audio: [{ id: 'a', name: 'music', assetId: 'x', start: 6.2, trimStart: 0, duration: 1.3, volume: 1, fadeIn: 0, fadeOut: 0, muted: false }],
  });

  it('playhead, project start/end, scene boundaries, bars, keyframes, cursor clicks and clip edges', () => {
    expect(timelineTargets(project, { playhead: 2.1, sceneId: 's1' })).toEqual([0, 0.5, 0.75, 1, 1.4, 1.5, 2.1, 2.5, 3, 4, 6.2, 7, 7.5, 10]);
  });

  it('leaves out what is being dragged', () => {
    const t = timelineTargets(project, {
      playhead: null,
      sceneId: 's1',
      exclude: { sceneId: 's2', layerBars: new Set(['r']), layerContent: new Set(['c']), keyIds: new Set(['k2']), clipIds: new Set(['a']) },
    });
    // No playhead, no scene B (4–7 except scene A's end at 4), no R bar (0.5, 2.5), no key k2 (1.5), no cursor click,
    // but the cursor's own bar (1, 3) and key k1 (0.75) stay.
    expect(t).toEqual([0, 0.75, 1, 3, 4, 10]);
  });

  it('only the scene shown in the timeline contributes layers', () => {
    expect(timelineTargets(project, { playhead: null, sceneId: 's2' })).toEqual([0, 4, 6.2, 7, 7.5, 10]);
  });
});
