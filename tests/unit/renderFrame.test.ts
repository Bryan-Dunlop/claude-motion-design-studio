// renderFrame must depend only on (project, time): render twice -> identical draw calls.
// (Pixel-level determinism in real Chromium is covered in tests/e2e/render.spec.ts.)
import { describe, expect, it } from 'vitest';
import { cursorPosition, frameCount, lastFrameTime, renderFrame } from '../../src/shared/renderFrame';
import { emptyProject, ProjectSchema, type CursorLayer } from '../../src/shared/schema';
import { sampleProject } from '../fixtures/sampleProject';
import { recordingCtx } from './helpers/recordingCtx';

describe('renderFrame', () => {
  it('is deterministic: same project + time -> identical draw calls', () => {
    const p = sampleProject();
    for (const t of [0, 0.37, 1.05, 2.5, 9.99]) {
      const a = recordingCtx();
      const b = recordingCtx();
      renderFrame(p, t, a.ctx, 0.5);
      renderFrame(p, t, b.ctx, 0.5);
      expect(a.log).toEqual(b.log);
      expect(a.log.length).toBeGreaterThan(5);
    }
  });

  it('time order does not matter (no accumulated state)', () => {
    const p = sampleProject();
    const direct = recordingCtx();
    renderFrame(p, 1.5, direct.ctx, 1);
    const seq = recordingCtx();
    for (const t of [3, 0, 1.2]) renderFrame(p, t, recordingCtx().ctx, 1);
    renderFrame(p, 1.5, seq.ctx, 1);
    expect(seq.log).toEqual(direct.log);
  });

  it('skips layers outside their time range and hidden layers', () => {
    const p = sampleProject();
    const at11 = recordingCtx();
    renderFrame(p, 11, at11.ctx, 1);
    expect(at11.log.some((l) => l.startsWith('fillText'))).toBe(false);
    p.scenes[0].layers[0].visible = false;
    const hidden = recordingCtx();
    renderFrame(p, 1, hidden.ctx, 1);
    expect(hidden.log.some((l) => l.startsWith('fillText'))).toBe(false);
  });

  it('cursor reaches each target point at its time, with smoothing in between', () => {
    const c = sampleProject().scenes[0].layers[1] as CursorLayer;
    expect(cursorPosition(c, 0)).toEqual({ x: 0, y: 0 });
    expect(cursorPosition(c, 1)).toEqual({ x: 100, y: 0 });
    expect(cursorPosition(c, 2)).toEqual({ x: 100, y: 100 });
    const straight = cursorPosition({ ...c, smoothing: 0 }, 1.5);
    const smooth = cursorPosition(c, 1.5);
    expect(straight.x).toBeCloseTo(100);
    expect(smooth.x).not.toBeCloseTo(100);
  });

  it('frameCount = duration * fps', () => {
    const p = sampleProject();
    expect(frameCount(p)).toBe(450);
  });

  it('empty project draws only the background', () => {
    const r = recordingCtx();
    renderFrame(emptyProject(), 0, r.ctx, 1);
    expect(r.log.filter((l) => l.startsWith('fillRect'))).toHaveLength(1);
  });
});

describe('renderFrame edge cases', () => {
  const spring = { type: 'spring', stiffness: 170, damping: 14, mass: 1 };
  const cursorProject = (cursor: object) =>
    ProjectSchema.parse({
      schemaVersion: 2,
      settings: { durationSec: 2, aspect: 'custom', width: 640, height: 360, fps: 30, background: '#ffffff' },
      assets: [],
      scenes: [{
        id: 's', name: 'S', start: 0, duration: 2,
        layers: [{
          id: 'c', name: 'Cursor', type: 'cursor', visible: true, locked: false, start: 0, duration: 2, anchorX: 0.5, anchorY: 0.5,
          x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, points: [{ id: 'p1', x: 200, y: 150, time: 0 }], clicks: [{ id: 'k1', time: 1.75 }],
          smoothing: 0.5, size: 48, color: '#ffffff', rippleColor: '#4f7cff66', keyframes: {}, ...cursor,
        }],
      }],
    });

  it('a cursor whose scale springs below 0 while a click ripples still draws (a real canvas throws on a negative radius)', () => {
    // A spring scale-out overshoots to about -0.13 between 1.77 s and 1.87 s, while the click at 1.75 s ripples.
    const p = cursorProject({ keyframes: { scale: [{ id: 'a', time: 1.4, value: 1, easing: spring }, { id: 'b', time: 2, value: 0, easing: spring }] } });
    for (let f = 45; f < 60; f++) expect(() => renderFrame(p, f / 30, recordingCtx(640, 360).ctx, 1), `frame ${f}`).not.toThrow();
  });

  it("cursor outline: '#fff' is outlined like '#ffffff' (3-digit hex is not 'dark')", () => {
    const outline = (color: string) => {
      const r = recordingCtx(640, 360);
      renderFrame(cursorProject({ color }), 0.5, r.ctx, 1);
      return r.log.filter((l) => l.startsWith('strokeStyle=')).at(-1);
    };
    expect(outline('#ffffff')).toBe('strokeStyle="#000000"');
    expect(outline('#fff')).toBe('strokeStyle="#000000"');
    expect(outline('#ff0')).toBe('strokeStyle="#000000"');
    expect(outline('#000')).toBe('strokeStyle="#ffffff"');
  });

  it('a see-through background goes over opaque black that covers the whole canvas (no trails from earlier frames)', () => {
    const p = emptyProject();
    p.settings.background = '#ffffff80';
    const r = recordingCtx(1000, 600);
    renderFrame(p, 0, r.ctx, 0.5);
    expect(r.log.slice(0, 9)).toEqual([
      'save([])', 'setTransform([1,0,0,1,0,0])', 'globalAlpha=1', 'globalCompositeOperation="source-over"', 'fillStyle="#000000"',
      'fillRect([0,0,1000,600])', 'setTransform([0.5,0,0,0.5,0,0])', 'globalAlpha=1', 'globalCompositeOperation="source-over"',
    ]);
    // An opaque background needs no black underneath: v1's calls, unchanged.
    p.settings.background = '#ffffff';
    const opaque = recordingCtx(1000, 600);
    renderFrame(p, 0, opaque.ctx, 0.5);
    expect(opaque.log.slice(0, 2)).toEqual(['save([])', 'setTransform([0.5,0,0,0.5,0,0])']);
    expect(opaque.log).not.toContain('fillStyle="#000000"');
  });

  it('lastFrameTime is the time of the last exported frame', () => {
    const p = emptyProject();
    p.settings.durationSec = 1;
    p.settings.fps = 30;
    expect(lastFrameTime(p)).toBeCloseTo(29 / 30, 12);
  });
});
