// Scene timing edits that keep a scene's layers in step with it. Pure: they edit the draft the caller commits (one
// undo step), or return numbers.
import type { Draft } from 'immer';
import { keepOutAtEnd } from '../shared/presets';
import type { Layer, Project, Scene } from '../shared/schema';

/** The longest video the project file allows (settings.durationSec). */
export const MAX_VIDEO_SEC = 3600;

/** Drop floating-point noise such as 22.500000000000004. */
const clean = (v: number) => Math.round(v * 1e9) / 1e9;

/**
 * A layer's duration after its scene's length changes from `before` to `after` (layer times are scene-relative):
 * - shorter: a layer that would run past the new end now ends there, so its exit animations (text "Animate out", which
 *   follows the layer's end) play before the cut instead of being cut off. It stays at least one frame long. A layer
 *   that starts at or after the new end is left as it is: it can't be seen either way.
 * - longer: a layer that ended at the old end (within half a frame) follows it.
 * - otherwise the length is kept.
 * Keyframes are never removed; only "Out" preset keyframes move, with the layer's end (resizeScene, keepOutAtEnd).
 */
export function followSceneEnd(layer: Pick<Layer, 'start' | 'duration'>, before: number, after: number, fps: number): number {
  const end = layer.start + layer.duration;
  if (after < before) {
    if (end <= after || layer.start >= after) return layer.duration;
    return Math.max(1 / fps, after - layer.start);
  }
  if (after > before && Math.abs(end - before) <= 0.5 / fps) return after - layer.start;
  return layer.duration;
}

/**
 * Give `scene` a new length and let its layers follow its end (followSceneEnd). `origin` is the scene as it was before
 * the edit — a timeline drag passes the scene from where the drag started, so moving back and forth within one drag
 * always ends where it would have from the start. Returns how many layers changed length.
 */
export function resizeScene(scene: Draft<Scene>, duration: number, fps: number, origin: Scene = scene as Scene): number {
  const before = new Map(origin.layers.map((l) => [l.id, { start: l.start, duration: l.duration, keyframes: l.keyframes }]));
  let changed = 0;
  for (const layer of scene.layers) {
    const o = before.get(layer.id);
    if (!o) continue;
    const d = followSceneEnd(o, origin.duration, duration, fps);
    if (d !== o.duration) changed++;
    layer.duration = d;
    layer.keyframes = keepOutAtEnd(o.keyframes, o.duration, d);
  }
  scene.duration = duration;
  return changed;
}

/**
 * Where a copy of `src` goes: right after the last scene, so it never lands on top of another scene, keeping its
 * length. `durationSec` is the video length it needs (longer only when the copy doesn't fit); null when that would
 * be longer than a video can be.
 */
export function duplicatePlacement(project: Pick<Project, 'scenes' | 'settings'>, src: Pick<Scene, 'duration'>): { start: number; durationSec: number } | null {
  const start = clean(Math.max(0, ...project.scenes.map((s) => s.start + s.duration)));
  const end = clean(start + src.duration);
  if (end > MAX_VIDEO_SEC) return null;
  return { start, durationSec: Math.max(project.settings.durationSec, end) };
}

/** What a Scenes list ↑/↓ did: swapped time slots, only swapped drawing order, or nothing (refused / no neighbour). */
export type SceneMove = 'swapped' | 'stacked' | 'blocked' | null;

type Span = Pick<Scene, 'start' | 'duration'>;
const overlaps = (a: Span, b: Span) => a.start < b.start + b.duration - 1e-9 && b.start < a.start + a.duration - 1e-9;

/**
 * Scenes list ↑/↓ (delta −1 / +1): move a scene one place in the list. When it and its neighbour don't overlap in time
 * they also swap time slots — each keeps its length and the gap between them stays — so the list stays the order the
 * scenes play in. Scenes that overlap only swap drawing order (lower in the list = drawn on top). Nothing changes
 * ('blocked') when swapping would make one of them overlap another scene, which only happens when that scene plays
 * between them (the list is out of time order) and they have different lengths.
 */
export function moveSceneInList(scenes: Draft<Scene>[], sceneId: string, delta: -1 | 1): SceneMove {
  const i = scenes.findIndex((s) => s.id === sceneId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= scenes.length) return null;
  const a = scenes[i];
  const b = scenes[j];
  const stacked = overlaps(a, b);
  if (!stacked) {
    const [first, second] = a.start <= b.start ? [a, b] : [b, a];
    const gap = second.start - (first.start + first.duration);
    // After the move, the one higher in the list takes the earlier slot.
    const [early, late] = delta < 0 ? [a, b] : [b, a];
    const earlyAt = { start: first.start, duration: early.duration };
    const lateAt = { start: clean(first.start + early.duration + gap), duration: late.duration };
    const others = scenes.filter((s) => s !== a && s !== b && !overlaps(s, first) && !overlaps(s, second));
    if (others.some((s) => overlaps(s, earlyAt) || overlaps(s, lateAt))) return 'blocked';
    early.start = earlyAt.start;
    late.start = lateAt.start;
  }
  scenes[i] = b;
  scenes[j] = a;
  return stacked ? 'stacked' : 'swapped';
}

/** Give a layer a new length (the Duration field); its "Out" preset keyframes move with its end (keepOutAtEnd). */
export function setLayerDuration(layer: Draft<Layer>, duration: number) {
  layer.keyframes = keepOutAtEnd(layer.keyframes, layer.duration, duration);
  layer.duration = duration;
}
