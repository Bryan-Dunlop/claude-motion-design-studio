// Scene timing edits that keep a scene's layers in step with it. Pure: they edit the draft the caller commits (one
// undo step), or return numbers.
import type { Draft } from 'immer';
import type { Layer, Scene } from '../shared/schema';

/**
 * A layer's duration after its scene's length changes from `before` to `after` (layer times are scene-relative):
 * - shorter: a layer that would run past the new end now ends there, so its exit animations (text "Animate out", which
 *   follows the layer's end) play before the cut instead of being cut off. It stays at least one frame long. A layer
 *   that starts at or after the new end is left as it is: it can't be seen either way.
 * - longer: a layer that ended at the old end (within half a frame) follows it.
 * - otherwise the length is kept. Keyframes are never moved or removed.
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
  const before = new Map(origin.layers.map((l) => [l.id, { start: l.start, duration: l.duration }]));
  let changed = 0;
  for (const layer of scene.layers) {
    const o = before.get(layer.id);
    if (!o) continue;
    const d = followSceneEnd(o, origin.duration, duration, fps);
    if (d !== o.duration) changed++;
    layer.duration = d;
  }
  scene.duration = duration;
  return changed;
}
