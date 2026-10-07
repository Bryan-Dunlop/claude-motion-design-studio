// "Make a copy in another format": re-frame a project so the old frame fits (centred) inside the new one.
// k = min(W2/W, H2/H); every position p → centre2 + k·(p − centre); every layer's scale × k. This maps each layer's
// whole box (and so its effects, which follow the layer scale) by the same similarity transform as the frame.
import { ASPECTS, type Keyframe, type Layer, type Project, type Settings } from './schema';

export type Format = keyof typeof ASPECTS;

/** Pixel size of `aspect` that keeps the project's long edge (same rule as the Aspect setting); even numbers. */
export function formatSize(settings: Pick<Settings, 'width' | 'height'>, aspect: Format): { width: number; height: number } {
  const [aw, ah] = ASPECTS[aspect];
  const long = Math.max(settings.width, settings.height);
  return aw >= ah ? { width: long, height: Math.round((long * ah) / aw / 2) * 2 } : { width: Math.round((long * aw) / ah / 2) * 2, height: long };
}

/** The named format of a size, or 'custom'. */
export function aspectOf(width: number, height: number): Settings['aspect'] {
  const hit = (Object.entries(ASPECTS) as [Format, [number, number]][]).find(([, [aw, ah]]) => Math.abs(width / height - aw / ah) < 0.002);
  return hit?.[0] ?? 'custom';
}

/** Drop floating-point noise such as 1462.5000000000002 (far below anything visible). */
const clean = (v: number) => Math.round(v * 1e9) / 1e9;

function mapKeys(keys: Keyframe[] | undefined, f: (v: number) => number) {
  for (const k of keys ?? []) if (typeof k.value === 'number') k.value = clean(f(k.value));
}

/** A copy of `project` at W2×H2 with every layer scaled and centred to fit; the input is not changed. */
export function fitToFrame(project: Project, W2: number, H2: number): Project {
  const { width: W, height: H } = project.settings;
  const k = Math.min(W2 / W, H2 / H);
  const mx = (x: number) => W2 / 2 + k * (x - W / 2);
  const my = (y: number) => H2 / 2 + k * (y - H / 2);
  const copy = structuredClone(project) as Project;
  copy.settings = { ...copy.settings, width: W2, height: H2, aspect: aspectOf(W2, H2) };
  const fit = (layer: Layer) => {
    layer.x = clean(mx(layer.x));
    layer.y = clean(my(layer.y));
    layer.scale = clean(layer.scale * k);
    mapKeys(layer.keyframes.x, mx);
    mapKeys(layer.keyframes.y, my);
    mapKeys(layer.keyframes.scale, (s) => s * k);
    // The cursor is drawn at its path points (project pixels), sized by size × scale.
    if (layer.type === 'cursor')
      for (const p of layer.points) {
        p.x = clean(mx(p.x));
        p.y = clean(my(p.y));
      }
  };
  for (const scene of copy.scenes) scene.layers.forEach(fit);
  return copy;
}
