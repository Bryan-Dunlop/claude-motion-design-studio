import { applyEasing } from './easing';
import type { Keyframe, Layer } from './schema';

export type RGBA = [number, number, number, number];

export function parseColor(input: string): RGBA {
  let s = input.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) return [0, 0, 0, 1];
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), s.length === 8 ? n(6) / 255 : 1];
}

export function formatColor([r, g, b, a]: RGBA): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return a >= 1 ? `#${h(r)}${h(g)}${h(b)}` : `#${h(r)}${h(g)}${h(b)}${h(a * 255)}`;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function interpolateValue(a: number | string, b: number | string, t: number): number | string {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t);
  if (typeof a === 'string' && typeof b === 'string') {
    const ca = parseColor(a);
    const cb = parseColor(b);
    return formatColor([lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t), lerp(ca[3], cb[3], t)]);
  }
  return t < 1 ? a : b;
}

/** Value of a keyframe track at `time` (seconds, same reference as the keyframe times). */
export function sampleKeyframes(keys: Keyframe[], time: number): number | string | undefined {
  if (keys.length === 0) return undefined;
  const sorted = keys.length > 1 ? [...keys].sort((a, b) => a.time - b.time) : keys;
  if (time <= sorted[0].time) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (time >= last.time) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const k0 = sorted[i];
    const k1 = sorted[i + 1];
    if (time >= k0.time && time < k1.time) {
      const span = k1.time - k0.time;
      const p = span <= 0 ? 1 : (time - k0.time) / span;
      return interpolateValue(k0.value, k1.value, applyEasing(k0.easing, p, span));
    }
  }
  return last.value;
}

/** Resolve a layer's property at a layer-local time, honouring keyframes. */
export function propAt<T extends number | string>(layer: Layer, prop: string, localTime: number): T {
  const keys = layer.keyframes[prop];
  const base = (layer as unknown as Record<string, unknown>)[prop] as T;
  if (!keys || keys.length === 0) return base;
  const v = sampleKeyframes(keys, localTime);
  if (v === undefined || typeof v !== typeof base) return base;
  return v as T;
}

/** Return a copy of the layer with every animated property replaced by its value at localTime. */
export function resolveLayer<L extends Layer>(layer: L, localTime: number): L {
  const props = Object.keys(layer.keyframes);
  if (props.length === 0) return layer;
  const out: Record<string, unknown> = { ...layer };
  for (const p of props) out[p] = propAt(layer, p, localTime);
  return out as L;
}
