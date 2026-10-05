// renderFrame must depend only on (project, time): render twice -> identical draw calls.
// (Pixel-level determinism in real Chromium is covered in tests/e2e/render.spec.ts.)
import { describe, expect, it } from 'vitest';
import { cursorPosition, frameCount, renderFrame } from '../../src/shared/renderFrame';
import { emptyProject, type CursorLayer } from '../../src/shared/schema';
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
