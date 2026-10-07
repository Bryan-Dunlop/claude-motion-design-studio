import type { Easing } from './schema';

/** Solve a CSS-style cubic-bezier timing curve: returns y for progress x. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  // Newton-Raphson, then bisection fallback. Fully deterministic.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-7) return sampleY(t);
    const d = slopeX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 40; i++) {
    const v = sampleX(t);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

/**
 * Damped harmonic oscillator going from 0 to 1, evaluated at `seconds` after release.
 * Closed-form, so any time can be sampled directly (no accumulated state).
 */
export function springValue(stiffness: number, damping: number, mass: number, seconds: number): number {
  if (seconds <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const t = seconds;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) {
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  }
  const s = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + s;
  const r2 = -zeta * w0 - s;
  const c2 = r1 / (r1 - r2);
  const c1 = 1 - c2;
  return 1 - (c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t));
}

/**
 * Map linear progress p (0..1) through an easing.
 * Springs use real seconds (`segmentSeconds * p`) so their feel doesn't depend on segment length;
 * they snap to exactly 1 at the end of the segment.
 */
export function applyEasing(easing: Easing, p: number, segmentSeconds = 1): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  switch (easing.type) {
    case 'linear':
      return p;
    case 'easeIn':
      return cubicBezier(0.42, 0, 1, 1, p);
    case 'easeOut':
      return cubicBezier(0, 0, 0.58, 1, p);
    case 'easeInOut':
      return cubicBezier(0.42, 0, 0.58, 1, p);
    case 'cubicBezier':
      return cubicBezier(easing.x1, easing.y1, easing.x2, easing.y2, p);
    case 'spring':
      return springValue(easing.stiffness, easing.damping, easing.mass, p * segmentSeconds);
  }
}

export const EASING_LABELS: Record<Easing['type'], { label: string; help: string }> = {
  linear: { label: 'Steady', help: 'Constant speed from start to finish.' },
  easeIn: { label: 'Speed up', help: 'Starts slow, ends fast — good for exits.' },
  easeOut: { label: 'Slow down', help: 'Starts fast, settles gently — good for entrances.' },
  easeInOut: { label: 'Smooth', help: 'Slow start, fast middle, slow end.' },
  cubicBezier: { label: 'Custom curve', help: 'Shape the speed curve yourself with two handles.' },
  spring: { label: 'Spring', help: 'Physical bounce. Stiffness = snappiness, damping = how fast the wobble dies, mass = heaviness.' },
};

export function defaultEasing(type: Easing['type']): Easing {
  switch (type) {
    case 'cubicBezier':
      return { type, x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
    case 'spring':
      return { type, stiffness: 170, damping: 14, mass: 1 };
    default:
      return { type };
  }
}
