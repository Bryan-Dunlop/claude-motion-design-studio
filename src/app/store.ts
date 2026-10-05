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
  missingAssets: Set<string>;
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
  select: (sel: Partial<Selection>) => void;
  selectKeys: (ids: string[]) => void;
  setMissingAssets: (m: Set<string>) => void;
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
    select: (sel) => set({ selection: { ...get().selection, ...sel } }),
    selectKeys: (selectedKeys) => set({ selectedKeys }),
    setMissingAssets: (missingAssets) => set({ missingAssets }),
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

export function layerLocalTime(scene: Pick<Scene, 'start'>, layer: Pick<Layer, 'start'>, time: number) {
  return time - scene.start - layer.start;
}

/** Keyframes within half a frame of `t` are "at" t. */
export function keyAt(keys: Keyframe[] | undefined, t: number, fps: number): Keyframe | undefined {
  return keys?.find((k) => Math.abs(k.time - t) < 0.5 / fps);
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
