import { describe, expect, it } from 'vitest';
import { formatColor, interpolateValue, parseColor, propAt, resolveLayer, sampleKeyframes } from '../../src/shared/interpolate';
import { makeLayer } from '../../src/shared/factories';
import type { Keyframe, ShapeLayer } from '../../src/shared/schema';

const kf = (time: number, value: number | string, type: 'linear' | 'easeIn' = 'linear'): Keyframe => ({ id: `k${time}`, time, value, easing: { type } });

const shape = (): ShapeLayer =>
  makeLayer({
  id: 'l1', name: 'S', type: 'shape', visible: true, locked: false, start: 0, duration: 5,
  anchorX: 0.5, anchorY: 0.5, x: 100, y: 100, scale: 1, rotation: 0, opacity: 1, keyframes: {},
  shape: 'rect', width: 100, height: 50, cornerRadius: 0, fill: '#ff0000', stroke: '#000000', strokeWidth: 0,
  });

describe('interpolation', () => {
  it('holds the first value before the first key and the last value after the last', () => {
    const keys = [kf(1, 10), kf(2, 20)];
    expect(sampleKeyframes(keys, 0)).toBe(10);
    expect(sampleKeyframes(keys, 1)).toBe(10);
    expect(sampleKeyframes(keys, 2)).toBe(20);
    expect(sampleKeyframes(keys, 99)).toBe(20);
  });

  it('interpolates linearly between keys', () => {
    const keys = [kf(0, 0), kf(2, 100)];
    expect(sampleKeyframes(keys, 0.5)).toBeCloseTo(25);
    expect(sampleKeyframes(keys, 1)).toBeCloseTo(50);
  });

  it('uses the easing of the earlier key for each segment', () => {
    const keys = [kf(0, 0, 'easeIn'), kf(1, 100), kf(2, 0)];
    expect(sampleKeyframes(keys, 0.5) as number).toBeLessThan(50);
    expect(sampleKeyframes(keys, 1.5)).toBeCloseTo(50); // second segment is linear
  });

  it('handles unsorted keyframes', () => {
    expect(sampleKeyframes([kf(2, 100), kf(0, 0)], 1)).toBeCloseTo(50);
  });

  it('interpolates colours channel-wise including alpha', () => {
    expect(interpolateValue('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(parseColor('#ff000080')[3]).toBeCloseTo(128 / 255);
    expect(formatColor(parseColor('#12345678'))).toBe('#12345678');
    expect(parseColor('#abc')).toEqual([170, 187, 204, 1]);
  });

  it('propAt falls back to the static value when not animated', () => {
    const l = shape();
    expect(propAt(l, 'x', 3)).toBe(100);
    l.keyframes.x = [kf(0, 0), kf(4, 400)];
    expect(propAt(l, 'x', 1)).toBeCloseTo(100);
    expect(propAt(l, 'x', 2)).toBeCloseTo(200);
  });

  it('resolveLayer replaces animated props and does not mutate the input', () => {
    const l = shape();
    l.keyframes.opacity = [kf(0, 0), kf(1, 1)];
    l.keyframes.fill = [kf(0, '#000000'), kf(1, '#ffffff')];
    const r = resolveLayer(l, 0.5);
    expect(r.opacity).toBeCloseTo(0.5);
    expect(r.fill).toBe('#808080');
    expect(l.opacity).toBe(1);
  });
});
