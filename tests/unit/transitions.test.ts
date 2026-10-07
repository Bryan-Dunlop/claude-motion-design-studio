import { describe, expect, it } from 'vitest';
import { makeScene } from '../../src/shared/factories';
import { emptyProject, type Project, type Scene } from '../../src/shared/schema';
import { partnerLocalTime, transitionPartner, transitionProgress, transitionWindow } from '../../src/shared/transitions';

const scene = (name: string, start: number, duration: number, type: Scene['transition']['type'] = 'none', d = 0.6): Scene =>
  makeScene({ id: name, name, start, duration, layers: [], transition: { type, duration: d, direction: 'left', easing: { type: 'linear' } } });

const project = (...scenes: Scene[]): Project => ({ ...emptyProject(), scenes });

describe('transition window', () => {
  it('is null for a cut and clamped to the scene length otherwise', () => {
    expect(transitionWindow(scene('a', 0, 5))).toBeNull();
    expect(transitionWindow(scene('b', 5, 5, 'fade', 0.6))).toEqual({ start: 5, end: 5.6, duration: 0.6 });
    expect(transitionWindow(scene('c', 5, 0.4, 'fade', 2))!.duration).toBeCloseTo(0.4);
  });

  it('progress runs 0 → 1 inside the window and is null outside', () => {
    const b = scene('b', 5, 5, 'fade', 1);
    expect(transitionProgress(b, 4.99)).toBeNull();
    expect(transitionProgress(b, 5)).toBe(0);
    expect(transitionProgress(b, 5.5)).toBeCloseTo(0.5);
    expect(transitionProgress(b, 6)).toBeNull();
  });
});

describe('transition partner', () => {
  it('sequential scenes: the scene that just ended', () => {
    const a = scene('Hook', 0, 5);
    const b = scene('Feature', 5, 5, 'fade');
    expect(transitionPartner(project(a, b), b)?.id).toBe('Hook');
  });

  it('overlapping scenes: the one ending inside the window', () => {
    const a = scene('A', 0, 5.3);
    const b = scene('B', 5, 5, 'fade', 0.6);
    expect(transitionPartner(project(a, b), b)?.id).toBe('A');
  });

  it('gap before the scene: no partner (transition from the background)', () => {
    const a = scene('A', 0, 4);
    const b = scene('B', 5, 5, 'fade');
    expect(transitionPartner(project(a, b), b)).toBeNull();
  });

  it('a long overlay scene running past the window is never the partner', () => {
    const hook = scene('Hook', 0, 5);
    const feature = scene('Feature', 5, 5, 'fade');
    const cta = scene('CTA', 10, 5, 'fade');
    const logo = scene('Logo bug', 0, 15);
    const p = project(hook, feature, cta, logo);
    expect(transitionPartner(p, feature)?.id).toBe('Hook');
    expect(transitionPartner(p, cta)?.id).toBe('Feature');
  });

  it('ties go to the later scene in the array; the greatest end wins', () => {
    const a = scene('A', 0, 5);
    const b = scene('B', 1, 4);
    const c = scene('C', 5, 5, 'fade');
    expect(transitionPartner(project(a, b, c), c)?.id).toBe('B');
    const d = scene('D', 2, 3.4);
    expect(transitionPartner(project(a, d, c), c)?.id).toBe('D');
  });

  it('cut scenes have no partner; the partner holds its last frame', () => {
    const a = scene('A', 0, 5);
    const b = scene('B', 5, 5);
    expect(transitionPartner(project(a, b), b)).toBeNull();
    expect(partnerLocalTime(a, 5.3)).toBeCloseTo(5 - 1e-6);
    expect(partnerLocalTime(a, 4.5)).toBeCloseTo(4.5);
  });
});
