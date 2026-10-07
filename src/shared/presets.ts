// Animation presets and stagger. Both GENERATE ordinary editable data (keyframes / start times).
import { ANIMATABLE, type Easing, type Keyframe, type Layer } from './schema';

export type PresetKind = 'slide' | 'fade' | 'scale' | 'draw';
export type PresetPhase = 'in' | 'out';
export type Direction = 'left' | 'right' | 'up' | 'down';

export interface PresetParams {
  kind: PresetKind;
  phase: PresetPhase;
  direction: Direction;
  /** Slide distance in project pixels. */
  distance: number;
  /** Seconds after layer start (in) or before layer end (out). */
  delay: number;
  duration: number;
  easing: Easing;
}

export const DEFAULT_PRESET: PresetParams = {
  kind: 'fade',
  phase: 'in',
  direction: 'up',
  distance: 200,
  delay: 0,
  duration: 0.6,
  easing: { type: 'easeOut' },
};

let idCounter = 0;
export function makeId(prefix = 'id'): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : (++idCounter).toString(36);
  return `${prefix}_${rnd}`;
}

function sourceTag(phase: PresetPhase) {
  return `preset:${phase}`;
}

/** Properties a preset animates on a layer. */
export function presetProps(params: Pick<PresetParams, 'kind' | 'direction'>): string[] {
  switch (params.kind) {
    case 'fade':
      return ['opacity'];
    case 'scale':
      return ['scale'];
    case 'slide':
      return [params.direction === 'left' || params.direction === 'right' ? 'x' : 'y', 'opacity'];
    case 'draw':
      // Shapes only (trimEnd is animatable on nothing else).
      return ['trimEnd'];
  }
}

/** A preset only applies to layers on which every property it animates is animatable (e.g. no slide on a cursor). */
export function presetApplies(layer: Layer, params: Pick<PresetParams, 'kind' | 'direction'>): boolean {
  return presetProps(params).every((p) => ANIMATABLE[layer.type].includes(p));
}

/**
 * Returns new keyframes map for `layer` with the preset applied.
 * Any keyframes previously generated for the same phase are removed first, so re-applying replaces.
 * Layers the preset doesn't apply to (see presetApplies) are returned unchanged.
 */
export function applyPreset(layer: Layer, params: PresetParams): Record<string, Keyframe[]> {
  if (!presetApplies(layer, params)) return layer.keyframes;
  const tag = sourceTag(params.phase);
  const result: Record<string, Keyframe[]> = {};
  for (const [prop, keys] of Object.entries(layer.keyframes)) {
    const kept = keys.filter((k) => k.source !== tag);
    if (kept.length) result[prop] = kept;
  }
  const dur = Math.max(0.01, Math.min(params.duration, layer.duration));
  const t0 = params.phase === 'in' ? Math.max(0, params.delay) : Math.max(0, layer.duration - params.delay - dur);
  const t1 = Math.min(layer.duration, t0 + dur);
  const base = layer as unknown as Record<string, number>;

  const add = (prop: string, offValue: number, onValue = base[prop]) => {
    const [v0, v1] = params.phase === 'in' ? [offValue, onValue] : [onValue, offValue];
    const keys = (result[prop] ?? []).filter((k) => k.time < t0 - 1e-6 || k.time > t1 + 1e-6);
    keys.push(
      { id: makeId('kf'), time: t0, value: v0, easing: params.easing, source: tag },
      { id: makeId('kf'), time: t1, value: v1, easing: params.easing, source: tag },
    );
    keys.sort((a, b) => a.time - b.time);
    result[prop] = keys;
  };

  if (params.kind === 'fade') add('opacity', 0);
  if (params.kind === 'scale') add('scale', 0);
  // Draw on: the outline draws itself from start to end (in: trim end 0 → 1; out: 1 → 0).
  if (params.kind === 'draw') add('trimEnd', 0, 1);
  if (params.kind === 'slide') {
    const d = params.distance;
    // Direction is the direction of travel. Entering "up" starts below and moves up.
    const sign = params.phase === 'in' ? -1 : 1;
    if (params.direction === 'left') add('x', base.x - sign * d);
    if (params.direction === 'right') add('x', base.x + sign * d);
    if (params.direction === 'up') add('y', base.y - sign * d);
    if (params.direction === 'down') add('y', base.y + sign * d);
    // Slides fade too, so the layer doesn't pop at the edge.
    add('opacity', 0);
  }
  return result;
}

/**
 * "Out" preset keyframes belong to the layer's end. When a layer's length changes from `before` to `after` (a trimmed
 * bar, the Duration field, a scene that gets shorter or longer), they move with the end — keyframe times count from the
 * layer's start — but never before the start. Every other keyframe stays where it is. Returns `keyframes` itself when
 * nothing moves.
 */
export function keepOutAtEnd(keyframes: Record<string, Keyframe[]>, before: number, after: number): Record<string, Keyframe[]> {
  const tag = sourceTag('out');
  const shift = after - before;
  const isOut = (k: Keyframe) => k.source === tag;
  if (shift === 0 || !Object.values(keyframes).some((keys) => keys.some(isOut))) return keyframes;
  const result: Record<string, Keyframe[]> = {};
  for (const [prop, keys] of Object.entries(keyframes)) {
    result[prop] = keys.some(isOut)
      ? keys.map((k) => (isOut(k) ? { ...k, time: Math.max(0, Math.round((k.time + shift) * 1e9) / 1e9) } : k)).sort((a, b) => a.time - b.time)
      : keys;
  }
  return result;
}

// ---------------------------------------------------------------- stagger

export type StaggerOrder = 'forward' | 'reverse' | 'random';

export interface StaggerParams {
  order: StaggerOrder;
  /** Seconds between consecutive layers. */
  interval: number;
  seed: number;
}

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns layerId -> new start time. `layers` is the selection in z-order. */
export function staggerStarts(layers: Pick<Layer, 'id' | 'start'>[], params: StaggerParams): Map<string, number> {
  const order = [...layers];
  if (params.order === 'reverse') order.reverse();
  if (params.order === 'random') {
    const rnd = seededRandom(params.seed);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  const base = Math.min(...layers.map((l) => l.start));
  const out = new Map<string, number>();
  order.forEach((l, i) => out.set(l.id, Math.max(0, base + i * params.interval)));
  return out;
}
