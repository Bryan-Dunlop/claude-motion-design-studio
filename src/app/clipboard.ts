// Copy / paste of keyframes, layers and audio clips. Pure: reads plain project data and edits the draft the caller
// commits (one undo step). The clipboard holds structuredClone'd data — committed state is frozen by immer.
import type { Draft } from 'immer';
import { propAt } from '../shared/interpolate';
import { ANIMATABLE, type Asset, type AudioClip, type Easing, type Layer, type LayerType, type Project } from '../shared/schema';
import { duplicateClipsAt } from './audio/clips';
import { deepCloneLayer } from './store';

export interface CopiedKey {
  prop: string;
  /** Absolute project time (s): pasting keeps the spacing between the copied keys. */
  time: number;
  value: number | string;
  easing: Easing;
  source?: string;
}

/** `from`: the saved project the layers / clips were copied from (its folder may hold their files). */
export type Clipboard =
  | { kind: 'keys'; keys: CopiedKey[] }
  | { kind: 'layers'; layers: Layer[]; assets: Asset[]; from?: string | null }
  | { kind: 'clips'; clips: AudioClip[]; assets: Asset[]; from?: string | null };

const tidy = (v: number) => Math.round(v * 1e6) / 1e6;

/** The selected keyframes, earliest first. */
export function copyKeys(project: Project, keyIds: readonly string[]): CopiedKey[] {
  const ids = new Set(keyIds);
  const out: CopiedKey[] = [];
  for (const scene of project.scenes)
    for (const layer of scene.layers)
      for (const [prop, keys] of Object.entries(layer.keyframes))
        for (const k of keys)
          if (ids.has(k.id))
            out.push(structuredClone({ prop, time: scene.start + layer.start + k.time, value: k.value, easing: k.easing, ...(k.source ? { source: k.source } : {}) }));
  return out.sort((a, b) => a.time - b.time);
}

/** Assets the layers / clips refer to (images, click sounds, fonts), so a paste into another project keeps them. */
function referencedAssets(project: Project, layers: readonly Layer[], clips: readonly AudioClip[] = []): Asset[] {
  const ids = new Set(clips.map((c) => c.assetId));
  const fonts = new Set<string>();
  for (const l of layers) {
    if (l.type === 'image') ids.add(l.assetId);
    if (l.type === 'cursor' && l.clickSound) ids.add(l.clickSound.assetId);
    if (l.type === 'text') fonts.add(l.fontFamily);
  }
  return project.assets.filter((a) => ids.has(a.id) || (a.type === 'font' && !!a.fontFamily && fonts.has(a.fontFamily))).map((a) => structuredClone(a));
}

/** The layers in drawing order (back to front), with the assets they use. */
export function copyLayers(project: Project, layerIds: readonly string[]): Extract<Clipboard, { kind: 'layers' }> {
  const layers = project.scenes.flatMap((s) => s.layers.filter((l) => layerIds.includes(l.id))).map((l) => structuredClone(l));
  return { kind: 'layers', layers, assets: referencedAssets(project, layers) };
}

export function copyClips(project: Project, clipIds: readonly string[]): Extract<Clipboard, { kind: 'clips' }> {
  const clips = project.audio.filter((c) => clipIds.includes(c.id)).map((c) => structuredClone(c));
  return { kind: 'clips', clips, assets: referencedAssets(project, [], clips) };
}

function addMissingAssets(draft: Draft<Project>, assets: readonly Asset[]) {
  for (const a of assets) if (!draft.assets.some((x) => x.id === a.id)) draft.assets.push(structuredClone(a));
}

export interface PasteKeysResult {
  /** Keyframes written (select these). */
  ids: string[];
  /** Keyframes left out because the layer type can't animate that property, and which types those were. */
  skipped: number;
  skippedTypes: LayerType[];
  /** Target layers the playhead is outside of: nothing was pasted on them. */
  refused: string[];
}

/**
 * Paste keyframes onto every target layer at the playhead `time` (absolute s): the earliest copied key lands on the
 * playhead and the others keep their spacing, clamped to [0, layer duration]. With `relative`, x/y values are shifted
 * so the first pasted x (and y) key equals the layer's current value at the playhead — the motion is reused from
 * where the layer is; every other property pastes as-is. Properties the layer can't animate are skipped; a key
 * already on the same frame is replaced. Layers the playhead is outside of are refused.
 */
export function pasteKeys(
  draft: Draft<Project>,
  targetIds: readonly string[],
  keys: readonly CopiedKey[],
  time: number,
  opts: { relative: boolean; newId: () => string },
): PasteKeysResult {
  const res: PasteKeysResult = { ids: [], skipped: 0, skippedTypes: [], refused: [] };
  if (keys.length === 0) return res;
  const halfFrame = 0.5 / draft.settings.fps;
  const t0 = Math.min(...keys.map((k) => k.time));
  const written = new Set<string>();
  for (const id of targetIds) {
    const scene = draft.scenes.find((s) => s.layers.some((l) => l.id === id));
    const layer = scene?.layers.find((l) => l.id === id) as Layer | undefined;
    if (!scene || !layer) continue;
    const local = time - scene.start - layer.start;
    if (local < -1e-9 || local > layer.duration + 1e-9) {
      res.refused.push(layer.name);
      continue;
    }
    const offset: Record<string, number> = {};
    if (opts.relative)
      for (const p of ['x', 'y']) {
        const first = keys.find((k) => k.prop === p);
        const current = propAt(layer, p, local);
        if (first && typeof first.value === 'number' && typeof current === 'number') offset[p] = current - first.value;
      }
    for (const k of keys) {
      if (!ANIMATABLE[layer.type].includes(k.prop)) {
        res.skipped++;
        if (!res.skippedTypes.includes(layer.type)) res.skippedTypes.push(layer.type);
        continue;
      }
      const t = tidy(Math.min(Math.max(0, local + k.time - t0), layer.duration));
      const value = typeof k.value === 'number' && offset[k.prop] !== undefined ? tidy(k.value + offset[k.prop]) : k.value;
      const track = (layer.keyframes[k.prop] ??= []);
      for (let i = track.length - 1; i >= 0; i--) {
        if (Math.abs(track[i].time - t) >= halfFrame) continue;
        written.delete(track[i].id);
        track.splice(i, 1);
      }
      const key = { id: opts.newId(), time: t, value, easing: structuredClone(k.easing), ...(k.source ? { source: k.source } : {}) };
      track.push(key);
      track.sort((a, b) => a.time - b.time);
      written.add(key.id);
    }
  }
  res.ids = [...written];
  return res;
}

/** "A" / "A" and "B" / "A", "B" and "C". */
function quoted(names: readonly string[]) {
  const q = names.map((n) => `"${n}"`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

/** Toast for a keyframe paste, e.g. `Pasted 6 keyframes (2 skipped: not available on text)`. */
export function pasteKeysMessage(r: PasteKeysResult): string {
  const n = r.ids.length;
  if (n === 0 && r.skipped === 0) return `Move the playhead inside ${quoted(r.refused)} to paste keyframes there.`;
  let msg = `Pasted ${n} keyframe${n === 1 ? '' : 's'}`;
  if (r.skipped) msg += ` (${r.skipped} skipped: not available on ${r.skippedTypes.join(' or ')})`;
  if (r.refused.length) msg += ` — move the playhead inside ${quoted(r.refused)} to paste there too`;
  return msg;
}

/**
 * Paste layers into a scene at the same scene-relative timing (new ids for the layers, their keyframes, cursor points
 * and clicks), in front of the existing ones. A name already used in that scene gets " copy". Returns the new ids.
 */
export function pasteLayers(draft: Draft<Project>, sceneId: string, clip: Extract<Clipboard, { kind: 'layers' }>): string[] {
  const scene = draft.scenes.find((s) => s.id === sceneId);
  if (!scene) return [];
  addMissingAssets(draft, clip.assets);
  const ids: string[] = [];
  for (const l of clip.layers) {
    const copy = deepCloneLayer(l);
    if (scene.layers.some((x) => x.name === copy.name)) copy.name = `${copy.name} copy`;
    scene.layers.push(copy);
    ids.push(copy.id);
  }
  return ids;
}

/** Paste audio clips at `at` (the earliest one there, the others keeping their spacing). Returns the new ids. */
export function pasteClips(draft: Draft<Project>, clip: Extract<Clipboard, { kind: 'clips' }>, at: number, newId: () => string): string[] {
  addMissingAssets(draft, clip.assets);
  const copies = duplicateClipsAt(clip.clips, clip.clips.map((c) => c.id), at, newId);
  draft.audio.push(...copies);
  return copies.map((c) => c.id);
}
