// Scene timing edits (src/app/sceneTiming.ts): layers follow a scene's end when it gets shorter or longer.
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { duplicatePlacement, followSceneEnd, MAX_VIDEO_SEC, moveSceneInList, resizeScene, type SceneMove } from '../../src/app/sceneTiming';
import { makeLayer, makeScene } from '../../src/shared/factories';
import type { Keyframe, Scene, Settings } from '../../src/shared/schema';

const FPS = 30;
const key = (id: string, time: number, value: number): Keyframe => ({ id, time, value, easing: { type: 'linear' } });
const rect = (id: string, start: number, duration: number, keyframes: Record<string, Keyframe[]> = {}) =>
  makeLayer({
    id, name: id, type: 'shape', shape: 'rect', visible: true, locked: false, start, duration, anchorX: 0.5, anchorY: 0.5,
    x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keyframes, width: 10, height: 10, cornerRadius: 0, fill: '#fff', stroke: '#000', strokeWidth: 0,
  });

/** Scene 0–15 s: `full` 0–15, `past` runs past the end (0–20), `early` ends at 4, `late` starts at 10. */
function scene(): Scene {
  return makeScene({
    id: 's', name: 'S', start: 0, duration: 15,
    layers: [rect('full', 0, 15, { opacity: [key('k1', 0, 0), key('k2', 14.4, 1), key('k3', 15, 0)] }), rect('past', 0, 20), rect('early', 0, 4), rect('late', 10, 5)],
  });
}
const lengths = (s: Scene) => Object.fromEntries(s.layers.map((l) => [l.id, Math.round(l.duration * 1e6) / 1e6]));

describe('followSceneEnd', () => {
  it('shorter: a layer that would run past the new end ends there (at least a frame); others keep their length', () => {
    expect(followSceneEnd({ start: 0, duration: 15 }, 15, 7.5, FPS)).toBe(7.5);
    expect(followSceneEnd({ start: 2, duration: 18 }, 15, 7.5, FPS)).toBe(5.5); // ran past the old end
    expect(followSceneEnd({ start: 0, duration: 10 }, 15, 7.5, FPS)).toBe(7.5); // ended before the old end, after the new one
    expect(followSceneEnd({ start: 0, duration: 4 }, 15, 7.5, FPS)).toBe(4); // ends before the new end
    expect(followSceneEnd({ start: 0, duration: 7.5 }, 15, 7.5, FPS)).toBe(7.5); // ends exactly at the new end
    expect(followSceneEnd({ start: 7.49, duration: 7.51 }, 15, 7.5, FPS)).toBe(1 / FPS); // never shorter than a frame
    expect(followSceneEnd({ start: 10, duration: 5 }, 15, 7.5, FPS)).toBe(5); // starts after the new end: unseen, kept
    expect(followSceneEnd({ start: 7.5, duration: 7.5 }, 15, 7.5, FPS)).toBe(7.5);
  });

  it('longer: only a layer that ended at the old end (within half a frame) follows it', () => {
    expect(followSceneEnd({ start: 0, duration: 7.5 }, 7.5, 10, FPS)).toBe(10);
    expect(followSceneEnd({ start: 2, duration: 5.49 }, 7.5, 10, FPS)).toBe(8); // 0.01 s short of the end
    expect(followSceneEnd({ start: 0, duration: 4 }, 7.5, 10, FPS)).toBe(4);
    expect(followSceneEnd({ start: 0, duration: 15 }, 7.5, 10, FPS)).toBe(15); // already ran past it
    expect(followSceneEnd({ start: 0, duration: 7.5 }, 7.5, 7.5, FPS)).toBe(7.5);
  });
});

describe('resizeScene', () => {
  it('shortens the layers that would run past the new end in the same edit, keeping every keyframe', () => {
    let changed = 0;
    const s = produce(scene(), (d) => void (changed = resizeScene(d, 7.5, FPS)));
    expect(s.duration).toBe(7.5);
    expect(lengths(s)).toEqual({ full: 7.5, past: 7.5, early: 4, late: 5 });
    expect(changed).toBe(2);
    expect(s.layers[0].keyframes).toEqual(scene().layers[0].keyframes);
  });

  it('longer: layers that ended with the scene follow it', () => {
    const s = produce(scene(), (d) => void resizeScene(d, 18, FPS));
    expect(lengths(s)).toEqual({ full: 18, past: 20, early: 4, late: 8 });
  });

  it('works from the origin during a drag, so going back and forth within the gesture is exact', () => {
    const origin = scene();
    let s = origin;
    for (const d of [12, 5, 3.2, 9, 16, 15]) s = produce(s, (draft) => void resizeScene(draft, d, FPS, origin));
    expect(lengths(s)).toEqual(lengths(origin));
    s = produce(s, (draft) => void resizeScene(draft, 9, FPS, origin));
    expect(lengths(s)).toEqual({ full: 9, past: 9, early: 4, late: 5 });
  });
});

describe('duplicatePlacement', () => {
  const at = (start: number, duration: number) => makeScene({ id: `s${start}`, name: 'S', start, duration, layers: [] });
  const project = (durationSec: number, ...scenes: Scene[]) => ({ scenes, settings: { durationSec } as Settings });

  it('goes after the last scene (never on top of one), making the video longer only when it has to', () => {
    expect(duplicatePlacement(project(15, at(0, 15)), at(0, 15))).toEqual({ start: 15, durationSec: 30 });
    // A copy of the first of two scenes still goes after the last one.
    expect(duplicatePlacement(project(15, at(0, 7.5), at(7.5, 7.5)), at(0, 7.5))).toEqual({ start: 15, durationSec: 22.5 });
    // Room after the last scene: the video keeps its length.
    expect(duplicatePlacement(project(40, at(0, 7.5), at(7.5, 7.5)), at(7.5, 7.5))).toEqual({ start: 15, durationSec: 40 });
    // The last scene in time decides, not the last in the list; floating-point noise is dropped.
    expect(duplicatePlacement(project(10, at(0.1 + 0.2, 7.2), at(0, 0.3)), at(0, 2.5))).toEqual({ start: 7.5, durationSec: 10 });
  });

  it('refuses when the video would get longer than the file allows', () => {
    expect(duplicatePlacement(project(3000, at(0, 3000)), at(0, 600))).toEqual({ start: 3000, durationSec: MAX_VIDEO_SEC });
    expect(duplicatePlacement(project(3000, at(0, 3000)), at(0, 601))).toBeNull();
  });
});

describe('moveSceneInList', () => {
  const sc = (id: string, start: number, duration: number) => makeScene({ id, name: id, start, duration, layers: [] });
  /** Run a list move; returns what happened and the list as [id, start, duration]. */
  function move(scenes: Scene[], id: string, delta: -1 | 1) {
    let result: SceneMove = null;
    const next = produce(scenes, (d) => void (result = moveSceneInList(d, id, delta)));
    return { result, list: next.map((s) => [s.id, s.start, s.duration]) };
  }

  it('scenes that follow each other swap time slots and places', () => {
    expect(move([sc('a', 0, 7.5), sc('b', 7.5, 7.5)], 'a', 1)).toEqual({ result: 'swapped', list: [['b', 0, 7.5], ['a', 7.5, 7.5]] });
    expect(move([sc('a', 0, 7.5), sc('b', 7.5, 7.5)], 'b', -1)).toEqual({ result: 'swapped', list: [['b', 0, 7.5], ['a', 7.5, 7.5]] });
  });

  it('each keeps its length and the gap stays between them', () => {
    expect(move([sc('a', 1, 4), sc('b', 7, 8)], 'b', -1)).toEqual({ result: 'swapped', list: [['b', 1, 8], ['a', 11, 4]] });
  });

  it('a list out of time order is put in order without moving anything in time', () => {
    expect(move([sc('b', 7.5, 7.5), sc('a', 0, 7.5)], 'b', 1)).toEqual({ result: 'swapped', list: [['a', 0, 7.5], ['b', 7.5, 7.5]] });
  });

  it('scenes that overlap only swap drawing order', () => {
    expect(move([sc('a', 0, 7.5), sc('b', 5, 7.5)], 'a', 1)).toEqual({ result: 'stacked', list: [['b', 5, 7.5], ['a', 0, 7.5]] });
    // A long overlay scene overlapping both doesn't stop two scenes from swapping.
    expect(move([sc('logo', 0, 15), sc('a', 0, 5), sc('b', 5, 10)], 'a', 1).list).toEqual([['logo', 0, 15], ['b', 0, 10], ['a', 10, 5]]);
  });

  it('refuses when a scene playing between them would end up overlapped; fine when the lengths are equal', () => {
    const between = [sc('a', 0, 4), sc('c', 6, 2), sc('b', 4, 2)];
    expect(move(between, 'a', 1)).toEqual({ result: 'blocked', list: between.map((s) => [s.id, s.start, s.duration]) });
    expect(move([sc('a', 0, 2), sc('c', 4, 2), sc('b', 2, 2)], 'a', 1)).toEqual({ result: 'swapped', list: [['c', 0, 2], ['a', 4, 2], ['b', 2, 2]] });
  });

  it('nothing to swap with at either end of the list', () => {
    expect(move([sc('a', 0, 5), sc('b', 5, 5)], 'a', -1)).toEqual({ result: null, list: [['a', 0, 5], ['b', 5, 5]] });
    expect(move([sc('a', 0, 5), sc('b', 5, 5)], 'b', 1).result).toBeNull();
  });
});
