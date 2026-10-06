// Keyframes dropped by a drag: one key per frame and property; the moved key wins.
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { makeLayer } from '../../src/shared/factories';
import { emptyProject, type Keyframe, type Project } from '../../src/shared/schema';
import { dropKeysUnderMoved } from '../../src/app/store';

const key = (id: string, time: number, value: number): Keyframe => ({ id, time, value, easing: { type: 'linear' } });

function project(x: Keyframe[], opacity: Keyframe[] = []): Project {
  const p = emptyProject();
  p.settings.fps = 30;
  const layer = makeLayer({ id: 'r', name: 'R', type: 'shape', shape: 'rect', visible: true, locked: false, start: 0, duration: 5, anchorX: 0.5, anchorY: 0.5, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
    width: 10, height: 10, cornerRadius: 0, fill: '#fff', stroke: '#000', strokeWidth: 0, keyframes: { x, ...(opacity.length ? { opacity } : {}) } });
  p.scenes = [{ id: 's', name: 'S', start: 0, duration: 5, background: null, transition: { type: 'none', duration: 0.5, direction: 'left', easing: { type: 'easeInOut' } }, layers: [layer] }];
  return p;
}
const track = (p: Project, prop: string) => (p.scenes[0].layers[0].keyframes[prop] ?? []).map((k) => [k.id, k.time]);

describe('dropKeysUnderMoved', () => {
  it('a moved key replaces a key of the same property on its frame (within half a frame); other properties keep theirs', () => {
    const p = project([key('a', 0, 1), key('b', 2, 2), key('c', 2.01, 3)], [key('o', 2, 1)]);
    const next = produce(p, (d) => dropKeysUnderMoved(d, new Set(['c'])));
    expect(track(next, 'x')).toEqual([['a', 0], ['c', 2.01]]);
    expect(track(next, 'opacity')).toEqual([['o', 2]]);
  });

  it('keys more than half a frame apart both stay; nothing moved, nothing changes', () => {
    const p = project([key('a', 2, 1), key('b', 2.02, 2)]);
    expect(produce(p, (d) => dropKeysUnderMoved(d, new Set(['b'])))).toBe(p);
    expect(produce(p, (d) => dropKeysUnderMoved(d, new Set()))).toBe(p);
  });

  it('two moved keys pushed onto one frame (clamped at the layer start): the first stays', () => {
    const p = project([key('a', 0, 1), key('b', 0, 2), key('c', 3, 3)]);
    const next = produce(p, (d) => dropKeysUnderMoved(d, new Set(['a', 'b'])));
    expect(track(next, 'x')).toEqual([['a', 0], ['c', 3]]);
  });
});
