import { describe, expect, it } from 'vitest';
import { applyEasing, cubicBezier, defaultEasing, EASING_LABELS, springValue } from '../../src/shared/easing';
import type { Easing } from '../../src/shared/schema';

const ALL: Easing[] = (Object.keys(EASING_LABELS) as Easing['type'][]).map(defaultEasing);

describe('easing', () => {
  it.each(ALL.map((e) => [e.type, e] as const))('%s starts at 0 and ends at exactly 1', (_t, e) => {
    expect(applyEasing(e, 0, 1)).toBe(0);
    expect(applyEasing(e, 1, 1)).toBe(1);
    expect(applyEasing(e, -0.5, 1)).toBe(0);
    expect(applyEasing(e, 1.5, 1)).toBe(1);
  });

  it.each(ALL.map((e) => [e.type, e] as const))('%s is deterministic', (_t, e) => {
    for (let p = 0; p <= 1; p += 0.05) expect(applyEasing(e, p, 0.8)).toBe(applyEasing(e, p, 0.8));
  });

  it('linear is identity', () => {
    for (const p of [0.1, 0.25, 0.5, 0.9]) expect(applyEasing({ type: 'linear' }, p)).toBeCloseTo(p, 10);
  });

  it('easeIn is below linear, easeOut above, easeInOut symmetric', () => {
    expect(applyEasing({ type: 'easeIn' }, 0.3)).toBeLessThan(0.3);
    expect(applyEasing({ type: 'easeOut' }, 0.3)).toBeGreaterThan(0.3);
    const a = applyEasing({ type: 'easeInOut' }, 0.3);
    const b = applyEasing({ type: 'easeInOut' }, 0.7);
    expect(a + b).toBeCloseTo(1, 5);
    expect(applyEasing({ type: 'easeInOut' }, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('cubic-bezier matches known CSS values', () => {
    // CSS "ease" = cubic-bezier(0.25, 0.1, 0.25, 1); at x=0.5, y ≈ 0.8024
    expect(cubicBezier(0.25, 0.1, 0.25, 1, 0.5)).toBeCloseTo(0.8024, 3);
    // Linear control points give identity.
    expect(cubicBezier(0.3, 0.3, 0.7, 0.7, 0.42)).toBeCloseTo(0.42, 5);
    // Overshooting curve goes above 1.
    const ys = Array.from({ length: 50 }, (_, i) => cubicBezier(0.3, 1.6, 0.6, 1.4, i / 50));
    expect(Math.max(...ys)).toBeGreaterThan(1);
  });

  it('cubic-bezier is monotonic for monotonic control points', () => {
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = cubicBezier(0.42, 0, 0.58, 1, i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('spring: underdamped overshoots, critically/overdamped do not, all settle to 1', () => {
    const under = Array.from({ length: 200 }, (_, i) => springValue(170, 8, 1, i / 100));
    expect(Math.max(...under)).toBeGreaterThan(1);
    const crit = 2 * Math.sqrt(170);
    const critVals = Array.from({ length: 200 }, (_, i) => springValue(170, crit, 1, i / 100));
    expect(Math.max(...critVals)).toBeLessThanOrEqual(1 + 1e-9);
    const over = Array.from({ length: 200 }, (_, i) => springValue(170, 60, 1, i / 100));
    expect(Math.max(...over)).toBeLessThanOrEqual(1 + 1e-9);
    expect(springValue(170, 26, 1, 5)).toBeCloseTo(1, 4);
    expect(springValue(170, crit, 1, 5)).toBeCloseTo(1, 4);
    expect(springValue(170, 60, 1, 10)).toBeCloseTo(1, 3);
  });

  it('spring uses real seconds: same physical time gives same value regardless of segment length', () => {
    const e: Easing = { type: 'spring', stiffness: 200, damping: 10, mass: 1 };
    expect(applyEasing(e, 0.25, 2)).toBeCloseTo(applyEasing(e, 0.5, 1), 10);
  });

  it('every easing has a plain-language label and help text', () => {
    for (const e of ALL) {
      expect(EASING_LABELS[e.type].label.length).toBeGreaterThan(2);
      expect(EASING_LABELS[e.type].help.length).toBeGreaterThan(10);
    }
  });
});
