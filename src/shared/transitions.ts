// Scene transition timing and the "outgoing partner" rule (docs/v2-plan.md, A1). Pure: used by renderFrame,
// the timeline strip and the Properties panel.
import { applyEasing } from './easing';
import type { Project, Scene, Transition } from './schema';

export const TRANSITION_LABELS: Record<Transition['type'], string> = {
  none: 'None (cut)',
  fade: 'Cross-fade',
  slide: 'Slide over',
  push: 'Push',
  wipe: 'Wipe',
  zoom: 'Zoom',
  blur: 'Blur',
};

/** Styles that move along a direction (the others ignore `direction`). */
export const DIRECTIONAL: Transition['type'][] = ['slide', 'push', 'wipe'];

export const DIRECTION_LABELS: Record<Transition['direction'], string> = {
  left: '← Right to left',
  right: '→ Left to right',
  up: '↑ Bottom to top',
  down: '↓ Top to bottom',
};

/** The transition window of `scene` ([start, end) in project seconds), or null for a hard cut. */
export function transitionWindow(scene: Scene): { start: number; end: number; duration: number } | null {
  if (scene.transition.type === 'none') return null;
  const duration = Math.min(scene.transition.duration, scene.duration);
  if (duration <= 0) return null;
  return { start: scene.start, end: scene.start + duration, duration };
}

/** Eased progress 0..1 of `scene`'s transition at project time t, or null outside its window. */
export function transitionProgress(scene: Scene, t: number): number | null {
  const w = transitionWindow(scene);
  if (!w || t < w.start || t >= w.end) return null;
  return applyEasing(scene.transition.easing, (t - w.start) / w.duration, w.duration);
}

const EPS = 1e-6;

/**
 * The scene `scene` transitions FROM: among the other scenes that start before it, those whose end lies inside the
 * transition window (S.start − ε ≤ end ≤ S.start + d); the greatest end wins, ties go to the later one in the array.
 * Scenes that keep running past the window (e.g. a long logo/overlay scene) are never partners.
 * Returns null when nothing ends there (the scene then transitions in over whatever is underneath).
 */
export function transitionPartner(project: Project, scene: Scene): Scene | null {
  const w = transitionWindow(scene);
  if (!w) return null;
  let best: Scene | null = null;
  let bestEnd = -Infinity;
  for (const other of project.scenes) {
    if (other.id === scene.id || !(other.start < scene.start)) continue;
    const end = other.start + other.duration;
    if (end < scene.start - EPS || end > w.end + EPS) continue;
    if (end >= bestEnd) {
      best = other;
      bestEnd = end;
    }
  }
  return best;
}

/** Local time at which an outgoing partner is drawn: it holds its last frame once it has ended. */
export function partnerLocalTime(partner: Scene, t: number): number {
  return Math.min(t - partner.start, partner.duration - EPS);
}
