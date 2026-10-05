import { describe, expect, it } from 'vitest';
import { applyPreset, DEFAULT_PRESET, seededRandom, staggerStarts } from '../../src/shared/presets';
import { sampleKeyframes } from '../../src/shared/interpolate';
import type { ShapeLayer } from '../../src/shared/schema';

const layer = (): ShapeLayer => ({
  id: 'l1', name: 'S', type: 'shape', visible: true, locked: false, start: 0, duration: 4,
  anchorX: 0.5, anchorY: 0.5, x: 500, y: 300, scale: 1, rotation: 0, opacity: 1, keyframes: {},
  shape: 'rect', width: 100, height: 50, cornerRadius: 0, fill: '#ff0000', stroke: '#000000', strokeWidth: 0,
});

describe('presets', () => {
  it('fade in generates regular keyframes from 0 to the layer opacity', () => {
    const k = applyPreset(layer(), { ...DEFAULT_PRESET, kind: 'fade', phase: 'in', delay: 0.5, duration: 1 });
    expect(k.opacity.map((x) => [x.time, x.value])).toEqual([[0.5, 0], [1.5, 1]]);
    expect(k.opacity.every((x) => x.source === 'preset:in')).toBe(true);
  });

  it('slide out moves in the travel direction and ends at the layer end', () => {
    const k = applyPreset(layer(), { ...DEFAULT_PRESET, kind: 'slide', phase: 'out', direction: 'right', distance: 200, delay: 0, duration: 1 });
    expect(k.x.map((x) => [x.time, x.value])).toEqual([[3, 500], [4, 700]]);
  });

  it('slide in "up" starts below and arrives at the base position', () => {
    const k = applyPreset(layer(), { ...DEFAULT_PRESET, kind: 'slide', phase: 'in', direction: 'up', distance: 100, duration: 1 });
    expect(sampleKeyframes(k.y, 0)).toBe(400);
    expect(sampleKeyframes(k.y, 1)).toBe(300);
  });

  it('re-applying replaces previous preset keys of the same phase and keeps manual keys', () => {
    const l = layer();
    l.keyframes.rotation = [{ id: 'manual', time: 2, value: 45, easing: { type: 'linear' } }];
    l.keyframes = applyPreset(l, { ...DEFAULT_PRESET, kind: 'scale', phase: 'in', duration: 1 });
    l.keyframes = applyPreset(l, { ...DEFAULT_PRESET, kind: 'scale', phase: 'in', duration: 0.5 });
    expect(l.keyframes.scale).toHaveLength(2);
    expect(l.keyframes.scale[1].time).toBe(0.5);
    expect(l.keyframes.rotation[0].id).toBe('manual');
    l.keyframes = applyPreset(l, { ...DEFAULT_PRESET, kind: 'scale', phase: 'out', duration: 0.5 });
    expect(l.keyframes.scale).toHaveLength(4);
  });
});

describe('stagger', () => {
  const ls = [
    { id: 'a', start: 1 },
    { id: 'b', start: 1.5 },
    { id: 'c', start: 3 },
  ];
  it('forward offsets from the earliest start', () => {
    expect([...staggerStarts(ls, { order: 'forward', interval: 0.2, seed: 1 })]).toEqual([['a', 1], ['b', 1.2], ['c', 1.4]]);
  });
  it('reverse', () => {
    const m = staggerStarts(ls, { order: 'reverse', interval: 0.5, seed: 1 });
    expect(m.get('c')).toBe(1);
    expect(m.get('a')).toBe(2);
  });
  it('seeded random is repeatable and a permutation', () => {
    const a = [...staggerStarts(ls, { order: 'random', interval: 1, seed: 42 })];
    const b = [...staggerStarts(ls, { order: 'random', interval: 1, seed: 42 })];
    expect(a).toEqual(b);
    expect(a.map(([, t]) => t).sort()).toEqual([1, 2, 3]);
    const r = seededRandom(7);
    const r2 = seededRandom(7);
    for (let i = 0; i < 10; i++) expect(r()).toBe(r2());
  });
});
