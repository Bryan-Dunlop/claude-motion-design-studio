// Editor state. The project is immutable data; every edit produces a new project via immer.
// History: `commit` = one undo step. Drags use begin/update/endGesture so one drag = one step.
import { produce, type Draft } from 'immer';
import { create } from 'zustand';
import { ANIMATABLE, emptyProject, type Keyframe, type Layer, type Project, type Scene } from '../shared/schema';
import { propAt } from '../shared/interpolate';
import { makeId } from '../shared/presets';

const HISTORY_LIMIT = 300;

export interface Selection {
  sceneId: string | null;
  layerIds: string[];
  /** Selected audio clips (project.audio ids). Selecting layers should clear this and vice versa. */
  audioIds: string[];
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

interface EditorState {
  project: Project;
  projectName: string | null;
  savedProject: Project;
  past: Project[];
  future: Project[];
  gestureBase: Project | null;

  time: number;
  playing: boolean;
  loop: boolean;
  /** When set, playback stops at this time (used by "Preview" buttons). */
  playUntil: number | null;
  zoom: number; // timeline pixels per second
  selection: Selection;
  /** Keyframe ids selected in the timeline (or just added with ◆). Filtered after undo/redo. */
  selectedKeys: string[];
  /** Images/fonts that failed to load (set by resources.ts). */
  missingAssets: Set<string>;
  /** Audio assets whose file is missing (set by the audio module; kept separate so neither loader overwrites the other). */
  missingAudio: Set<string>;
  toasts: Toast[];

  commit: (recipe: (draft: Draft<Project>) => void) => void;
  beginGesture: () => void;
  updateGesture: (recipe: (draft: Draft<Project>) => void) => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;

  loadProject: (project: Project, name: string | null) => void;
  markSaved: (project: Project, name: string) => void;

  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  /** Play [start, end] once and stop (clamped to the project). */
  previewRange: (start: number, end: number) => void;
  setLoop: (l: boolean) => void;
  setZoom: (z: number) => void;
  /**
   * Change the selection. Invariants (every UI path relies on them):
   * - selecting layers clears the clip selection and keeps only keyframes that belong to those layers;
   * - selecting clips clears the layer and keyframe selections.
   */
  select: (sel: Partial<Selection>) => void;
  /** Select keyframes: their layers become (part of) the layer selection and the clip selection is cleared. */
  selectKeys: (ids: string[]) => void;
  /** Esc: clear keyframes first, then clips, then layers. */
  clearSelectionStep: () => void;
  setMissingAssets: (m: Set<string>) => void;
  setMissingAudio: (m: Set<string>) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;

export const useEditor = create<EditorState>((set, get) => {
  const initial = emptyProject();
  return {
    project: initial,
    projectName: null,
    savedProject: initial,
    past: [],
    future: [],
    gestureBase: null,
    time: 0,
    playing: false,
    loop: false,
    playUntil: null,
    zoom: 60,
    selection: { sceneId: null, layerIds: [], audioIds: [] },
    selectedKeys: [],
    missingAssets: new Set(),
    missingAudio: new Set(),
    toasts: [],

    commit: (recipe) => {
      const { project, past, gestureBase } = get();
      if (gestureBase) {
        // A commit during a gesture just folds into it.
        set({ project: produce(project, recipe) });
        return;
      }
      const next = produce(project, recipe);
      if (next === project) return;
      set({ project: next, past: [...past, project].slice(-HISTORY_LIMIT), future: [] });
      fixSelection(set, get);
    },
    beginGesture: () => {
      if (!get().gestureBase) set({ gestureBase: get().project });
    },
    updateGesture: (recipe) => {
      set({ project: produce(get().project, recipe) });
    },
    endGesture: () => {
      const { gestureBase, project, past } = get();
      if (!gestureBase) return;
      if (gestureBase === project) set({ gestureBase: null });
      else set({ gestureBase: null, past: [...past, gestureBase].slice(-HISTORY_LIMIT), future: [] });
    },
    undo: () => {
      const { past, project, future, gestureBase } = get();
      if (gestureBase || past.length === 0) return;
      set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] });
      fixSelection(set, get);
    },
    redo: () => {
      const { past, project, future, gestureBase } = get();
      if (gestureBase || future.length === 0) return;
      set({ project: future[0], future: future.slice(1), past: [...past, project] });
      fixSelection(set, get);
    },

    loadProject: (project, name) =>
      set({
        project,
        projectName: name,
        savedProject: project,
        past: [],
        future: [],
        gestureBase: null,
        time: 0,
        playing: false,
        selection: { sceneId: project.scenes[0]?.id ?? null, layerIds: [], audioIds: [] },
        selectedKeys: [],
      }),
    markSaved: (project, name) => set({ savedProject: project, projectName: name }),

    setTime: (t) => {
      const max = get().project.settings.durationSec;
      set({ time: Math.min(Math.max(0, t), max) });
    },
    setPlaying: (playing) => set(playing ? { playing } : { playing, playUntil: null }),
    previewRange: (start, end) => {
      const dur = get().project.settings.durationSec;
      const s0 = Math.min(Math.max(0, start), dur);
      set({ time: s0, playUntil: Math.min(Math.max(s0, end), dur), playing: false });
      // Toggle so the playback effect restarts from the new time even if it was already playing.
      queueMicrotask(() => set({ playing: true }));
    },
    setLoop: (loop) => set({ loop }),
    setZoom: (zoom) => set({ zoom: Math.min(800, Math.max(5, zoom)) }),
    select: (sel) => {
      const { selection, selectedKeys, project } = get();
      const next: Selection = { ...selection, ...sel };
      let keys = selectedKeys;
      if (sel.layerIds !== undefined) {
        if (sel.layerIds.length > 0 && sel.audioIds === undefined) next.audioIds = [];
        const owners = keyOwners(project);
        keys = keys.filter((k) => next.layerIds.includes(owners.get(k)?.layerId ?? ''));
      }
      if (sel.audioIds !== undefined && sel.audioIds.length > 0) {
        if (sel.layerIds === undefined) next.layerIds = [];
        keys = [];
      }
      set({ selection: next, selectedKeys: keys });
    },
    selectKeys: (ids) => {
      const { selection, project } = get();
      if (ids.length === 0) return set({ selectedKeys: [] });
      const owners = keyOwners(project);
      const layers = ids.map((k) => owners.get(k)).filter((o): o is NonNullable<typeof o> => !!o);
      set({
        selectedKeys: ids,
        selection: {
          sceneId: layers[0]?.sceneId ?? selection.sceneId,
          layerIds: [...new Set([...selection.layerIds, ...layers.map((o) => o.layerId)])],
          audioIds: [],
        },
      });
    },
    clearSelectionStep: () => {
      const { selectedKeys, selection } = get();
      if (selectedKeys.length) set({ selectedKeys: [] });
      else if (selection.audioIds.length) set({ selection: { ...selection, audioIds: [] } });
      else set({ selection: { ...selection, layerIds: [] } });
    },
    setMissingAssets: (missingAssets) => set({ missingAssets }),
    setMissingAudio: (missingAudio) => set({ missingAudio }),
    toast: (text, kind = 'info') => {
      const id = ++toastId;
      set({ toasts: [...get().toasts, { id, kind, text }] });
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 3500);
    },
    dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  };
});

function fixSelection(set: (s: Partial<EditorState>) => void, get: () => EditorState) {
  const { project, selection } = get();
  const scene = project.scenes.find((s) => s.id === selection.sceneId) ?? null;
  const ids = new Set(project.scenes.flatMap((s) => s.layers.map((l) => l.id)));
  const layerIds = selection.layerIds.filter((id) => ids.has(id));
  const clipIds = new Set(project.audio.map((c) => c.id));
  const audioIds = selection.audioIds.filter((id) => clipIds.has(id));
  if ((scene?.id ?? null) !== selection.sceneId || layerIds.length !== selection.layerIds.length || audioIds.length !== selection.audioIds.length) {
    set({ selection: { sceneId: scene?.id ?? null, layerIds, audioIds } });
  }
  const keyIds = new Set(project.scenes.flatMap((s) => s.layers.flatMap((l) => Object.values(l.keyframes).flatMap((ks) => ks.map((k) => k.id)))));
  const selectedKeys = get().selectedKeys.filter((id) => keyIds.has(id));
  if (selectedKeys.length !== get().selectedKeys.length) set({ selectedKeys });
}

// ---------------------------------------------------------------- selectors & helpers

export function isDirty(s: Pick<EditorState, 'project' | 'savedProject'>) {
  return s.project !== s.savedProject;
}

export function findLayer(project: Project | Draft<Project>, layerId: string): { scene: Scene; layer: Layer } | null {
  for (const scene of project.scenes) {
    const layer = scene.layers.find((l) => l.id === layerId);
    if (layer) return { scene: scene as Scene, layer: layer as Layer };
  }
  return null;
}

/** keyframe id -> the layer/scene it belongs to. */
export function keyOwners(project: Project): Map<string, { layerId: string; sceneId: string }> {
  const m = new Map<string, { layerId: string; sceneId: string }>();
  for (const scene of project.scenes)
    for (const layer of scene.layers)
      for (const keys of Object.values(layer.keyframes)) for (const k of keys) m.set(k.id, { layerId: layer.id, sceneId: scene.id });
  return m;
}

export function layerLocalTime(scene: Pick<Scene, 'start'>, layer: Pick<Layer, 'start'>, time: number) {
  return time - scene.start - layer.start;
}

/** Keyframes within half a frame of `t` are "at" t. */
export function keyAt(keys: Keyframe[] | undefined, t: number, fps: number): Keyframe | undefined {
  return keys?.find((k) => Math.abs(k.time - t) < 0.5 / fps);
}

/**
 * After keyframes `moved` were dragged: a moved key that lands on the frame of another key of the same property
 * replaces it (like pasting onto a frame), so a frame never holds two keys of one property. Of two moved keys pushed
 * onto one frame (clamped at the layer's start or end), the first one stays.
 */
export function dropKeysUnderMoved(draft: Draft<Project>, moved: ReadonlySet<string>) {
  const half = 0.5 / draft.settings.fps;
  for (const scene of draft.scenes)
    for (const layer of scene.layers)
      for (const [prop, keys] of Object.entries(layer.keyframes)) {
        const kept: Keyframe[] = [];
        for (const k of keys.filter((k) => moved.has(k.id))) if (!kept.some((m) => Math.abs(m.time - k.time) < half)) kept.push(k);
        if (!kept.length) continue;
        const stays = (k: Keyframe) => (moved.has(k.id) ? kept.includes(k) : !kept.some((m) => Math.abs(m.time - k.time) < half));
        if (keys.every(stays)) continue;
        layer.keyframes[prop] = keys.filter(stays);
      }
}

/**
 * Set a property the way an animator expects: if the property is animated, write a keyframe at the
 * playhead (creating one if needed); otherwise change the static value.
 */
export function setProp(draft: Draft<Project>, layerId: string, prop: string, value: number | string, time: number) {
  const hit = findLayer(draft, layerId);
  if (!hit) return;
  const layer = hit.layer as unknown as Record<string, unknown> & Layer;
  const keys = layer.keyframes[prop];
  if (keys && keys.length && ANIMATABLE[layer.type].includes(prop)) {
    const local = clampTime(layerLocalTime(hit.scene, layer, time), layer.duration);
    const existing = keyAt(keys, local, draft.settings.fps);
    if (existing) existing.value = value;
    else {
      keys.push({ id: makeId('kf'), time: local, value, easing: { type: 'easeInOut' } });
      keys.sort((a, b) => a.time - b.time);
    }
  } else {
    layer[prop] = value;
  }
}

/** Current (possibly animated) value of a prop at the playhead. */
export function currentValue(scene: Scene, layer: Layer, prop: string, time: number) {
  return propAt(layer, prop, layerLocalTime(scene, layer, time));
}

/** Add a keyframe at the playhead (with id `newId`), or remove the one already there. */
export function toggleKeyframe(draft: Draft<Project>, layerId: string, prop: string, time: number, newId = makeId('kf')): 'added' | 'removed' | null {
  const hit = findLayer(draft, layerId);
  if (!hit) return null;
  const layer = hit.layer;
  const local = clampTime(layerLocalTime(hit.scene, layer, time), layer.duration);
  const keys = (layer.keyframes[prop] ??= []);
  const existing = keyAt(keys, local, draft.settings.fps);
  if (existing) {
    keys.splice(keys.indexOf(existing), 1);
    if (keys.length === 0) delete layer.keyframes[prop];
    return 'removed';
  }
  // The first keyframe takes the static value, so toggling it on changes nothing visually.
  const value = propAt(layer, prop, local);
  keys.push({ id: newId, time: local, value, easing: { type: 'easeInOut' } });
  keys.sort((a, b) => a.time - b.time);
  return 'added';
}

export function clampTime(t: number, duration: number) {
  return Math.min(Math.max(0, t), duration);
}

export function snapToFrame(t: number, fps: number) {
  return Math.round(t * fps) / fps;
}

export function deepCloneLayer(layer: Layer): Layer {
  const copy = JSON.parse(JSON.stringify(layer)) as Layer;
  copy.id = makeId('layer');
  for (const keys of Object.values(copy.keyframes)) for (const k of keys) k.id = makeId('kf');
  if (copy.type === 'cursor') {
    for (const p of copy.points) p.id = makeId('pt');
    for (const c of copy.clicks) c.id = makeId('click');
  }
  return copy;
}
