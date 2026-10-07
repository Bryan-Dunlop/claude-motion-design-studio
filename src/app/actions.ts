// User-level operations (each is one undo step) and server calls.
import type { Draft } from 'immer';
import { assetUrl } from '../shared/assetUrl';
import { makeId } from '../shared/presets';
import { makeLayer, makeScene } from '../shared/factories';
import { aspectOf, fitToFrame, formatSize } from '../shared/fitToFrame';
import { safeFileName } from '../shared/names';
import { emptyProject, ProjectSchema, type Asset, type AudioClip, type Layer, type Project, type Scene, type Settings, type ShapeKind } from '../shared/schema';
import { clockLabel, duplicateClipsAt, newClip } from './audio/clips';
import { loadAudioInfo } from './audio/waveform';
import { copyClips, copyKeys, copyLayers, pasteClips, pasteKeys, pasteKeysMessage, pasteLayers, type Clipboard, type CopiedKey, type PasteKeysResult } from './clipboard';
import { duplicatePlacement, MAX_VIDEO_SEC, moveSceneInList, resizeScene, type SceneMove } from './sceneTiming';
import { deepCloneLayer, findLayer, snapToFrame, useEditor } from './store';

const S = () => useEditor.getState();

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      msg = ((await r.json()) as { error: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

// ---------------------------------------------------------------- scenes

/**
 * Where a new scene goes, so scenes follow each other (and a transition always has a scene to come from):
 * - the first scene covers the whole video;
 * - if there is room after the last scene, the new scene fills it;
 * - otherwise the last scene is split — at the playhead when it is inside that scene, else in the middle. Its layers
 *   that would run past the cut end there (sceneTiming.resizeScene), so their exit animations still play.
 * Layers and keyframes are never deleted.
 */
function planNewScene(project: Project, time: number): { scene: Scene; split: { id: string; duration: number } | null } {
  const { durationSec: total, fps } = project.settings;
  const make = (start: number, duration: number) =>
    makeScene({ id: makeId('scene'), name: `Scene ${project.scenes.length + 1}`, start, duration, layers: [] });
  if (project.scenes.length === 0) return { scene: make(0, total), split: null };
  const MIN = 0.5;
  const last = project.scenes.reduce((a, b) => (b.start + b.duration > a.start + a.duration ? b : a));
  const lastEnd = last.start + last.duration;
  if (lastEnd <= total - MIN) return { scene: make(lastEnd, total - lastEnd), split: null };
  if (last.duration >= 2 * MIN) {
    const inside = time >= last.start + MIN && time <= lastEnd - MIN;
    const at = snapToFrame(inside ? time : last.start + last.duration / 2, fps);
    return { scene: make(at, lastEnd - at), split: { id: last.id, duration: at - last.start } };
  }
  // The last scene is too short to split: add a short scene at the end (may overlap it).
  const start = Math.max(0, Math.min(lastEnd, total - MIN));
  return { scene: make(start, Math.max(MIN, total - start)), split: null };
}

function showScene(scene: Scene) {
  const { time } = S();
  if (time < scene.start || time >= scene.start + scene.duration) S().setTime(scene.start);
}

/** Shorten the scene `split` names (planNewScene) in a draft; returns how many of its layers now end earlier. */
function applySplit(d: Draft<Project>, split: { id: string; duration: number } | null): number {
  const s = split && d.scenes.find((x) => x.id === split.id);
  return s ? resizeScene(s, split.duration, d.settings.fps) : 0;
}

/** Tooltip of the "+ Scene" buttons (Scenes panel and toolbar): what planNewScene does, in plain words. */
export const ADD_SCENE_TIP =
  'Add a scene. The first one fills the whole video; each next one fills the time after the last scene. If no time is left, the last scene is split in two (at the playhead if it is inside that scene, otherwise in the middle) and its layers that ran past the cut end there.';

export function addScene() {
  const { scene, split } = planNewScene(S().project, S().time);
  let cut = 0;
  S().commit((d) => {
    cut = applySplit(d, split);
    d.scenes.push(scene);
  });
  S().select({ sceneId: scene.id, layerIds: [], audioIds: [] });
  showScene(scene);
  if (split) {
    const name = S().project.scenes.find((x) => x.id === split.id)?.name ?? 'The previous scene';
    const layers = cut === 0 ? '' : cut === 1 ? ' 1 of its layers now ends there too.' : ` ${cut} of its layers now end there too.`;
    S().toast(`${scene.name} starts at ${scene.start.toFixed(2)} s — ${name} now ends there.${layers}`);
  }
  return scene.id;
}

/** Scene to add layers to: the selected one, else the one under the playhead, else null (a new one is needed). */
function targetSceneId(): string | null {
  const { project, selection, time } = S();
  if (selection.sceneId && project.scenes.some((s) => s.id === selection.sceneId)) return selection.sceneId;
  const atHead = project.scenes.find((s) => time >= s.start && time < s.start + s.duration);
  return atHead?.id ?? null;
}

/**
 * ⧉: a copy of a scene (all its layers, new ids) after the last scene — last in the list too, which is the order scenes
 * play in. The video gets longer when the copy doesn't fit. One undo step; the playhead moves to the copy.
 */
export function duplicateScene(sceneId: string) {
  const { project } = S();
  const src = project.scenes.find((s) => s.id === sceneId);
  if (!src) return;
  const place = duplicatePlacement(project, src);
  if (!place) return S().toast(`There is no room for a copy of ${src.name}: a video can be at most ${MAX_VIDEO_SEC / 60} minutes long.`, 'error');
  const copy: Scene = { ...structuredClone(src), id: makeId('scene'), name: `${src.name} copy`, start: place.start, layers: src.layers.map(deepCloneLayer) };
  const longer = place.durationSec > project.settings.durationSec;
  S().commit((d) => {
    d.scenes.push(copy);
    d.settings.durationSec = place.durationSec;
  });
  S().select({ sceneId: copy.id, layerIds: [], audioIds: [] });
  S().setTime(copy.start);
  S().toast(`${copy.name} starts at ${copy.start.toFixed(2)} s${longer ? ` — the video is now ${+place.durationSec.toFixed(2)} s` : ''}.`);
}

export function deleteScene(sceneId: string) {
  S().commit((d) => {
    d.scenes = d.scenes.filter((s) => s.id !== sceneId);
  });
}

/** Scenes list ↑/↓: see sceneTiming.moveSceneInList. One undo step; a toast when only the drawing order changed. */
export function moveScene(sceneId: string, delta: -1 | 1) {
  const { scenes } = S().project;
  const i = scenes.findIndex((s) => s.id === sceneId);
  const moved = scenes[i];
  const other = scenes[i + delta];
  if (!moved || !other) return;
  let result = null as SceneMove;
  S().commit((d) => void (result = moveSceneInList(d.scenes, sceneId, delta)));
  const onTop = delta > 0 ? moved : other;
  if (result === 'stacked')
    S().toast(`${moved.name} and ${other.name} overlap in time, so only the drawing order changed: ${onTop.name} is now drawn on top where they overlap.`);
  if (result === 'blocked') S().toast(`${moved.name} and ${other.name} can’t swap places: another scene plays between them. Drag the scene blocks in the timeline instead.`, 'error');
}

export function renameScene(sceneId: string, name: string) {
  S().commit((d) => {
    const s = d.scenes.find((x) => x.id === sceneId);
    if (s && name.trim()) s.name = name.trim();
  });
}

function moveInArray<T>(arr: T[], pred: (x: T) => boolean, delta: number) {
  const i = arr.findIndex(pred);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= arr.length) return;
  const [x] = arr.splice(i, 1);
  arr.splice(j, 0, x);
}

// ---------------------------------------------------------------- layers

function baseLayer(name: string, scene: Scene, settings: Settings) {
  return {
    id: makeId('layer'),
    name,
    visible: true,
    locked: false,
    start: 0,
    duration: scene.duration,
    anchorX: 0.5,
    anchorY: 0.5,
    x: settings.width / 2,
    y: settings.height / 2,
    scale: 1,
    rotation: 0,
    opacity: 1,
    keyframes: {},
  };
}

/** Add a layer to the target scene. If there is no scene yet, the scene is created in the same undo step. */
function addLayer(make: (scene: Scene, settings: Settings) => Layer) {
  const existing = targetSceneId();
  const plan = existing ? null : planNewScene(S().project, S().time);
  const created = plan?.scene ?? null;
  const sceneId = existing ?? created!.id;
  let id = '';
  S().commit((d) => {
    applySplit(d, plan?.split ?? null);
    if (created) d.scenes.push(created);
    const scene = d.scenes.find((s) => s.id === sceneId) as Scene | undefined;
    if (!scene) return;
    const layer = make(scene, d.settings);
    id = layer.id;
    scene.layers.push(layer);
  });
  S().select({ sceneId, layerIds: [id], audioIds: [] });
  if (created) showScene(created);
  return id;
}

export function addText() {
  return addLayer((scene, st) =>
    makeLayer({
      ...baseLayer('Text', scene, st),
      type: 'text',
      content: 'Your text',
      fontFamily: 'Inter',
      fontSize: Math.round(st.height * 0.08),
      fontWeight: 700,
      lineHeight: 1.2,
      letterSpacing: 0,
      align: 'center',
      color: '#ffffff',
    }),
  );
}

const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  star: 'Star',
  polygon: 'Polygon',
  line: 'Line',
};

export function addShape(shape: ShapeKind) {
  return addLayer((scene, st) => {
    const short = Math.min(st.width, st.height);
    const size = Math.round(short * 0.3);
    const common = { ...baseLayer(SHAPE_NAMES[shape], scene, st), type: 'shape' as const, shape, cornerRadius: 0, stroke: '#ffffff', strokeWidth: 0 };
    switch (shape) {
      case 'rect':
        return makeLayer({ ...common, width: size, height: size, cornerRadius: Math.round(size * 0.08), fill: '#4f7cff' });
      case 'ellipse':
        return makeLayer({ ...common, width: size, height: size, fill: '#4f7cff' });
      case 'triangle':
        return makeLayer({ ...common, width: size, height: Math.round(size * 0.87), fill: '#ffb020' });
      case 'star':
        return makeLayer({ ...common, width: size, height: size, fill: '#ffd23f', points: 5, innerRadius: 0.45 });
      case 'polygon':
        return makeLayer({ ...common, width: size, height: size, fill: '#22c55e', points: 6 });
      case 'line':
        // A line is drawn across the middle of its box; the box height only sets how easy it is to grab.
        return makeLayer({ ...common, width: Math.round(size * 1.6), height: Math.max(8, Math.round(short * 0.04)), fill: '#00000000', strokeWidth: Math.max(2, Math.round(short * 0.008)) });
    }
  });
}

export function addCursor() {
  return addLayer((scene, st) => {
    const d = Math.min(scene.duration, 2);
    return makeLayer({
      ...baseLayer('Cursor', scene, st),
      type: 'cursor',
      points: [
        { id: makeId('pt'), x: st.width * 0.35, y: st.height * 0.6, time: 0 },
        { id: makeId('pt'), x: st.width * 0.55, y: st.height * 0.45, time: d * 0.6 },
      ],
      clicks: [{ id: makeId('click'), time: d * 0.7 }],
      smoothing: 0.5,
      size: Math.round(st.height * 0.035),
      color: '#ffffff',
      rippleColor: '#ffffff66',
      // A subtle shadow like a real OS pointer.
      shadow: true,
      shadowColor: '#00000059',
      shadowBlur: Math.round(st.height * 0.035 * 0.15),
      shadowOffsetY: Math.round(st.height * 0.035 * 0.06),
    });
  });
}

export function addImageLayer(asset: Asset) {
  return addLayer((scene, st) => {
    const nw = asset.width ?? st.width / 2;
    const nh = asset.height ?? st.height / 2;
    // Fit inside 60% of the frame without ever upscaling beyond natural size for bitmaps.
    const fit = Math.min((st.width * 0.6) / nw, (st.height * 0.6) / nh, asset.type === 'svg' ? Infinity : 1);
    return makeLayer({
      ...baseLayer(asset.originalName.replace(/\.[^.]+$/, ''), scene, st),
      type: 'image',
      assetId: asset.id,
      width: Math.max(1, Math.round(nw * fit)),
      height: Math.max(1, Math.round(nh * fit)),
    });
  });
}

export function updateLayers(ids: string[], recipe: (layer: Draft<Layer>, scene: Draft<Scene>) => void) {
  S().commit((d) => {
    for (const id of ids) {
      for (const scene of d.scenes) {
        const layer = scene.layers.find((l) => l.id === id);
        if (layer) recipe(layer, scene);
      }
    }
  });
}

export function deleteLayers(ids: string[]) {
  if (!ids.length) return;
  S().commit((d) => {
    for (const s of d.scenes) s.layers = s.layers.filter((l) => !ids.includes(l.id));
  });
  S().select({ layerIds: [] });
}

export function duplicateLayers(ids: string[]) {
  const newIds: string[] = [];
  S().commit((d) => {
    for (const id of ids) {
      const hit = findLayer(d, id);
      if (!hit) continue;
      const scene = d.scenes.find((s) => s.id === hit.scene.id)!;
      const copy = deepCloneLayer(hit.layer);
      copy.name = `${hit.layer.name} copy`;
      const i = scene.layers.findIndex((l) => l.id === id);
      scene.layers.splice(i + 1, 0, copy);
      newIds.push(copy.id);
    }
  });
  S().select({ layerIds: newIds });
}

/** delta +1 = towards the front (later in the array). */
export function moveLayer(id: string, delta: -1 | 1) {
  S().commit((d) => {
    for (const s of d.scenes) moveInArray(s.layers, (l) => l.id === id, delta);
  });
}

// ---------------------------------------------------------------- keyframes

/** Delete keyframes (one undo step); the layers stay. A property left without keyframes keeps its static value. */
export function deleteKeys(ids: readonly string[]) {
  if (!ids.length) return;
  const gone = new Set(ids);
  S().commit((d) => {
    for (const scene of d.scenes)
      for (const layer of scene.layers)
        for (const [prop, keys] of Object.entries(layer.keyframes)) {
          if (!keys.some((k) => gone.has(k.id))) continue;
          const kept = keys.filter((k) => !gone.has(k.id));
          if (kept.length) layer.keyframes[prop] = kept;
          else delete layer.keyframes[prop];
        }
  });
  S().selectKeys([]);
}

// ---------------------------------------------------------------- clipboard (Ctrl+C / Ctrl+V)

/** In-memory clipboard (plain cloned data; survives opening another project). */
let clipboard: Clipboard | null = null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Ctrl+C: the selected keyframes if there are any, else the selected audio clips, else the selected layers. */
export function copySelection(): boolean {
  const { project, selection, selectedKeys } = S();
  if (selectedKeys.length) {
    const keys = copyKeys(project, selectedKeys);
    clipboard = { kind: 'keys', keys };
    S().toast(`Copied ${plural(keys.length, 'keyframe')}. Select a layer and press Ctrl+V to paste them at the playhead.`);
  } else if (selection.audioIds.length) {
    const clip = copyClips(project, selection.audioIds);
    clipboard = { ...clip, from: S().projectName };
    S().toast(`Copied ${plural(clip.clips.length, 'audio clip')}. Ctrl+V pastes at the playhead.`);
  } else if (selection.layerIds.length) {
    const clip = copyLayers(project, selection.layerIds);
    clipboard = { ...clip, from: S().projectName };
    S().toast(`Copied ${plural(clip.layers.length, 'layer')}. Ctrl+V pastes into the selected scene.`);
  } else return false;
  return true;
}

/**
 * Ctrl+V: paste what was copied, as one undo step, and select it. Keyframes go onto every selected layer at the
 * playhead (x/y relative to where each layer is; `absolute` = Ctrl+Shift+V keeps the copied values); layers go into
 * the selected scene at the same timing; clips go to the playhead.
 */
export async function pasteClipboard(opts: { absolute?: boolean } = {}) {
  let clip = clipboard;
  if (!clip) return S().toast('Nothing to paste yet: select keyframes, layers or audio clips and press Ctrl+C first.');
  if (clip.kind === 'keys') return pasteKeyframes(clip.keys, !opts.absolute);
  const at = S().time;
  const existing = clip.kind === 'layers' ? targetSceneId() : null;
  if (clip.from && clip.from !== S().projectName) clip = { ...clip, assets: await adoptAssets(clip.from, clip.assets) };
  if (clip.kind === 'clips') {
    let ids: string[] = [];
    S().commit((d) => void (ids = pasteClips(d, clip, at, () => makeId('clip'))));
    S().select({ audioIds: ids });
    return;
  }
  // No scene to paste into: a new one, placed like "+ Scene" (it may split the last scene, in the same undo step).
  const plan = existing ? null : planNewScene(S().project, at);
  const created = plan?.scene ?? null;
  const sceneId = existing ?? created!.id;
  let ids: string[] = [];
  S().commit((d) => {
    applySplit(d, plan?.split ?? null);
    if (created) d.scenes.push(created);
    ids = pasteLayers(d, sceneId, clip);
  });
  S().select({ sceneId, layerIds: ids, audioIds: [] });
  if (created) showScene(created);
}

/**
 * Pasting into another project: files that exist only in the source project's folder (e.g. it was imported from a
 * .zip) are copied byte-for-byte into the workspace store first, so this project finds them and saves them. Returns
 * the assets as pasted: a file whose bytes no longer match its recorded hash (replaced by hand) is pasted under its
 * real hash. A file that is gone from the source too is pasted as missing (Relink…).
 */
async function adoptAssets(from: string, assets: readonly Asset[]): Promise<Asset[]> {
  return Promise.all(
    assets.map(async (a) => {
      try {
        if ((await fetch(assetUrl(null, a), { method: 'HEAD' })).ok) return a; // already in the store
        const r = await fetch(assetUrl(from, a));
        if (!r.ok) return a;
        const { hash } = await api<{ hash: string }>('/api/assets', {
          method: 'POST',
          body: await r.arrayBuffer(),
          headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(a.originalName) },
        });
        return hash === a.hash ? a : { ...a, hash, relativePath: `assets/${hash.slice(0, 8)}-${safeFileName(a.originalName)}` };
      } catch {
        return a; // pasted as missing
      }
    }),
  );
}

function pasteKeyframes(keys: CopiedKey[], relative: boolean) {
  const { selection, time } = S();
  if (!selection.layerIds.length) return S().toast('Select the layer(s) to paste the keyframes onto.');
  let r: PasteKeysResult = { ids: [], skipped: 0, skippedTypes: [], refused: [] };
  S().commit((d) => void (r = pasteKeys(d, selection.layerIds, keys, time, { relative, newId: () => makeId('kf') })));
  if (r.ids.length) S().selectKeys(r.ids);
  S().toast(pasteKeysMessage(r), r.ids.length ? 'info' : 'error');
}

// ---------------------------------------------------------------- settings

export function updateSettings(patch: Partial<Settings>) {
  S().commit((d) => {
    const st = d.settings;
    Object.assign(st, patch);
    // A new aspect keeps the long edge and changes the ratio.
    if (patch.aspect && patch.aspect !== 'custom') Object.assign(st, formatSize(st, patch.aspect));
    if ((patch.width !== undefined || patch.height !== undefined) && !patch.aspect) st.aspect = aspectOf(st.width, st.height);
    // Layers are never deleted by a settings change.
  });
  const { time, project } = S();
  if (time > project.settings.durationSec) S().setTime(project.settings.durationSec);
}

/**
 * Project settings → Resolution: a new frame size of the same shape, with the whole composition scaled to it (the
 * fitToFrame mapping "Make a copy in another format" uses), so the picture stays the same. One undo step.
 */
export function resizeComposition(width: number, height: number) {
  const { project } = S();
  const { width: W, height: H } = project.settings;
  if (width === W && height === H) return;
  const fitted = fitToFrame(project, width, height);
  S().commit((d) => {
    d.settings = fitted.settings;
    d.scenes = fitted.scenes;
  });
  const k = Math.min(width / W, height / H);
  S().toast(`Resized to ${width}×${height}: every layer was scaled with the frame (× ${+k.toFixed(3)}).`);
}

// ---------------------------------------------------------------- assets

async function sha256Hex(buf: ArrayBuffer) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** File types the importer accepts (also the file inputs' `accept` lists). */
export const IMAGE_EXTS = '.png,.jpg,.jpeg,.webp,.svg';
export const FONT_EXTS = '.ttf,.otf,.woff,.woff2';
export const AUDIO_EXTS = '.mp3,.wav,.ogg,.m4a,.aac,.flac';
export const IMPORT_ACCEPT = `${IMAGE_EXTS},${FONT_EXTS},${AUDIO_EXTS}`;

function classify(file: File): Asset['type'] | null {
  const n = file.name.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(n)) return 'image';
  if (/\.svg$/.test(n)) return 'svg';
  if (/\.(ttf|otf|woff2?)$/.test(n)) return 'font';
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(n)) return 'audio';
  return null;
}

/** Images and SVGs can replace each other; fonts and sounds only their own kind. */
const kindOf = (t: Asset['type']) => (t === 'svg' ? 'image' : t);

async function imageSize(url: string): Promise<{ width: number; height: number } | null> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return { width: img.naturalWidth || 512, height: img.naturalHeight || 512 };
  } catch {
    return null;
  }
}

/** Upload original bytes (unmodified) and describe them as an Asset. */
async function uploadFile(file: File, keepId?: string): Promise<Asset> {
  const type = classify(file);
  if (!type) throw new Error(`${file.name}: unsupported file type (use PNG, JPG, WebP, SVG, TTF, OTF, WOFF, WOFF2, MP3, WAV, OGG, M4A, AAC or FLAC)`);
  const bytes = await file.arrayBuffer();
  const { hash } = await api<{ hash: string }>('/api/assets', {
    method: 'POST',
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
  });
  if (hash !== (await sha256Hex(bytes))) throw new Error(`${file.name}: upload corrupted`);
  const safe = safeFileName(file.name);
  const asset: Asset = { id: keepId ?? makeId('asset'), originalName: file.name, relativePath: `assets/${hash.slice(0, 8)}-${safe}`, type, hash };
  if (type === 'font') {
    asset.fontFamily = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, ' ').trim() || 'Imported font';
  } else if (type === 'audio') {
    // Never through imageSize(): length (+ waveform peaks, cached) from a low-rate decode, or ffmpeg on the server.
    const info = await loadAudioInfo(asset, null, bytes);
    if (!info || !(info.duration > 0.001)) throw new Error(`${file.name}: could not read this audio file`);
    asset.duration = Math.round(info.duration * 1e6) / 1e6;
  } else {
    const size = await imageSize(assetUrl(null, asset));
    if (!size) throw new Error(`${file.name}: could not decode image`);
    Object.assign(asset, size);
  }
  return asset;
}

export async function importFiles(files: File[]) {
  for (const file of files) {
    try {
      const asset = await uploadFile(file);
      const existing = S().project.assets.find((a) => a.hash === asset.hash);
      const use = existing ?? asset;
      if (use.type === 'audio') {
        addClip(use, { newAsset: existing ? undefined : asset });
        continue;
      }
      if (!existing) S().commit((d) => void d.assets.push(asset));
      if (use.type === 'font') S().toast(`Font "${use.fontFamily}" added — pick it in a text layer's Font menu.`);
      else addImageLayer(use);
    } catch (e) {
      S().toast((e as Error).message, 'error');
    }
  }
}

/**
 * Cursor panel "Import sound…": add a sound file to the project — without a clip on the timeline — and make it the
 * click sound of cursor `layerId` (keeping its click volume), in one undo step. A file already in the project is reused.
 */
export async function importClickSound(layerId: string, file: File) {
  try {
    if (classify(file) !== 'audio') throw new Error(`${file.name}: pick a sound file (MP3, WAV, OGG, M4A, AAC or FLAC) to use as the click sound.`);
    const asset = await uploadFile(file);
    const existing = S().project.assets.find((a) => a.hash === asset.hash && a.type === 'audio');
    const use = existing ?? asset;
    let cursorName = '';
    S().commit((d) => {
      const l = findLayer(d, layerId)?.layer;
      if (l?.type !== 'cursor') return;
      if (!existing) d.assets.push(asset);
      l.clickSound = { assetId: use.id, volume: l.clickSound?.volume ?? 1 };
      cursorName = l.name;
    });
    if (!cursorName) return S().toast(`${file.name} was not added: its cursor layer is gone.`, 'error');
    S().toast(`${use.originalName} is now the click sound of ${cursorName}.`);
  } catch (e) {
    S().toast((e as Error).message, 'error');
  }
}

// ---------------------------------------------------------------- audio clips

/**
 * Add a clip of an audio asset (new-clip defaults in audio/clips.ts) and select it. With `newAsset`, the asset is
 * added in the same undo step. `atPlayhead` always places it at the playhead ("+ at playhead").
 */
export function addClip(asset: Asset, opts: { newAsset?: Asset; atPlayhead?: boolean } = {}) {
  const { project, time } = S();
  const clip = newClip(asset, project, time, makeId('clip'), { atPlayhead: opts.atPlayhead });
  S().commit((d) => {
    if (opts.newAsset) d.assets.push(opts.newAsset);
    d.audio.push(clip);
  });
  S().select({ audioIds: [clip.id] });
  S().toast(`Added ${asset.originalName} at ${clockLabel(clip.start)} — see the Audio rows`);
  return clip.id;
}

/** Change clips in one undo step. */
export function updateClips(ids: string[], recipe: (clip: Draft<AudioClip>) => void) {
  S().commit((d) => {
    for (const c of d.audio) if (ids.includes(c.id)) recipe(c);
  });
}

export function deleteClips(ids: string[]) {
  if (!ids.length) return;
  S().commit((d) => {
    d.audio = d.audio.filter((c) => !ids.includes(c.id));
  });
  S().select({ audioIds: [] });
}

/** Ctrl+D: copies of the selected clips, the earliest at the playhead (others keep their spacing). */
export function duplicateClips(ids: string[]) {
  const { project, time } = S();
  const copies = duplicateClipsAt(project.audio, ids, time, () => makeId('clip'));
  if (!copies.length) return;
  S().commit((d) => void d.audio.push(...copies));
  S().select({ audioIds: copies.map((c) => c.id) });
}

/** Point an existing asset id at a new file; layers using it keep working. */
export async function relinkAsset(assetId: string, file: File) {
  try {
    const old = S().project.assets.find((a) => a.id === assetId);
    if (!old) return;
    const type = classify(file);
    if (type && kindOf(type) !== kindOf(old.type)) throw new Error(`${file.name}: pick a ${kindOf(old.type) === 'audio' ? 'sound' : kindOf(old.type)} file to replace ${old.originalName}`);
    const asset = await uploadFile(file, assetId);
    if (old.type === 'font') asset.fontFamily = old.fontFamily;
    S().commit((d) => {
      const i = d.assets.findIndex((a) => a.id === assetId);
      if (i >= 0) d.assets[i] = asset;
    });
    S().toast(`Relinked ${old.originalName} → ${file.name}`);
  } catch (e) {
    S().toast((e as Error).message, 'error');
  }
}

// ---------------------------------------------------------------- save / open

export async function listProjects() {
  return api<{ name: string; modified: number }[]>('/api/projects');
}

/**
 * Write a project folder. When saving under another name than the open project (Save as…, format copies), the server
 * is told where it came from (`from`): assets of an opened or imported project may exist only in its own folder.
 */
function putProject(name: string, project: Project) {
  const from = S().projectName;
  const q = from && from !== name ? `?from=${encodeURIComponent(from)}` : '';
  return api<{ name: string; project: Project; missing?: string[] }>(`/api/projects/${encodeURIComponent(name)}${q}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  });
}

export async function saveProject(name?: string): Promise<boolean> {
  const target = name ?? S().projectName;
  if (!target) return false;
  try {
    const project = S().project;
    const r = await putProject(target, project);
    S().markSaved(project, r.name);
    S().toast(`Saved ${r.name}.motion`);
    warnMissingFiles(r.missing);
    return true;
  } catch (e) {
    S().toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

/** Files the server could not find while saving: the project still refers to them, without the file. */
function warnMissingFiles(missing: string[] | undefined) {
  if (!missing?.length) return;
  const n = missing.length;
  S().toast(`${n === 1 ? '1 file was' : `${n} files were`} not found and could not be saved with the project: ${missing.join(', ')}. Use Relink… to point to ${n === 1 ? 'it' : 'them'}, then save again.`, 'error');
}

/** Save `copy` as a new project called `name` and open it (Make a copy in another format…). */
export async function saveCopyAs(copy: Project, name: string): Promise<boolean> {
  try {
    const r = await putProject(name, copy);
    S().loadProject(ProjectSchema.parse(r.project), r.name);
    warnMissingFiles(r.missing);
    return true;
  } catch (e) {
    S().toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

export async function openProject(name: string) {
  try {
    const r = await api<{ name: string; project: Project }>(`/api/projects/${encodeURIComponent(name)}`);
    S().loadProject(ProjectSchema.parse(r.project), r.name);
  } catch (e) {
    S().toast(`Open failed: ${(e as Error).message}`, 'error');
  }
}

export function newProject() {
  S().loadProject(emptyProject(), null);
}

export async function downloadZip() {
  const { project, projectName } = S();
  const r = await fetch('/api/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, name: projectName }),
  });
  if (!r.ok) return S().toast('Zip export failed', 'error');
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${projectName ?? 'Untitled'}.motion.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export async function importZip(file: File) {
  try {
    const r = await api<{ name: string; project: Project }>('/api/import-zip', {
      method: 'POST',
      body: await file.arrayBuffer(),
      headers: { 'Content-Type': 'application/zip', 'X-Filename': encodeURIComponent(file.name) },
    });
    S().loadProject(ProjectSchema.parse(r.project), r.name);
    S().toast(`Imported as ${r.name}.motion`);
  } catch (e) {
    S().toast(`Import failed: ${(e as Error).message}`, 'error');
  }
}

export { api };
