// User-level operations (each is one undo step) and server calls.
import type { Draft } from 'immer';
import { assetUrl } from '../shared/assetUrl';
import { makeId } from '../shared/presets';
import { ASPECTS, emptyProject, ProjectSchema, type Asset, type Layer, type Project, type Scene, type Settings } from '../shared/schema';
import { deepCloneLayer, findLayer, useEditor } from './store';

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

export function addScene() {
  const { project, time } = S();
  const id = makeId('scene');
  const lastEnd = Math.max(0, ...project.scenes.map((s) => s.start + s.duration));
  const start = project.scenes.length === 0 ? 0 : Math.min(lastEnd, Math.max(0, project.settings.durationSec - 1));
  const duration = Math.max(1, project.scenes.length === 0 ? project.settings.durationSec : Math.min(5, project.settings.durationSec - start));
  S().commit((d) => {
    d.scenes.push({ id, name: `Scene ${d.scenes.length + 1}`, start, duration, layers: [] });
  });
  S().select({ sceneId: id, layerIds: [] });
  if (time < start || time >= start + duration) S().setTime(start);
  return id;
}

/** Scene to add layers to: the selected one, else the one under the playhead, else a new one. */
function targetScene(): string {
  const { project, selection, time } = S();
  if (selection.sceneId && project.scenes.some((s) => s.id === selection.sceneId)) return selection.sceneId;
  const atHead = project.scenes.find((s) => time >= s.start && time < s.start + s.duration);
  return atHead?.id ?? addScene();
}

export function duplicateScene(sceneId: string) {
  const id = makeId('scene');
  S().commit((d) => {
    const i = d.scenes.findIndex((s) => s.id === sceneId);
    if (i < 0) return;
    const src = d.scenes[i] as Scene;
    const copy: Scene = { ...JSON.parse(JSON.stringify(src)), id, name: `${src.name} copy` };
    copy.layers = src.layers.map(deepCloneLayer);
    copy.start = Math.min(src.start + src.duration, Math.max(0, d.settings.durationSec - src.duration));
    d.scenes.splice(i + 1, 0, copy);
  });
  S().select({ sceneId: id, layerIds: [] });
}

export function deleteScene(sceneId: string) {
  S().commit((d) => {
    d.scenes = d.scenes.filter((s) => s.id !== sceneId);
  });
}

export function moveScene(sceneId: string, delta: -1 | 1) {
  S().commit((d) => moveInArray(d.scenes, (s) => s.id === sceneId, delta));
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

function addLayer(make: (scene: Scene, settings: Settings) => Layer) {
  const sceneId = targetScene();
  let id = '';
  S().commit((d) => {
    const scene = d.scenes.find((s) => s.id === sceneId) as Scene | undefined;
    if (!scene) return;
    const layer = make(scene, d.settings);
    id = layer.id;
    scene.layers.push(layer);
  });
  S().select({ sceneId, layerIds: [id] });
  return id;
}

export function addText() {
  return addLayer((scene, st) => ({
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
  }));
}

export function addShape(shape: 'rect' | 'ellipse') {
  return addLayer((scene, st) => {
    const size = Math.round(Math.min(st.width, st.height) * 0.3);
    return {
      ...baseLayer(shape === 'rect' ? 'Rectangle' : 'Ellipse', scene, st),
      type: 'shape',
      shape,
      width: size,
      height: size,
      cornerRadius: shape === 'rect' ? Math.round(size * 0.08) : 0,
      fill: '#4f7cff',
      stroke: '#ffffff',
      strokeWidth: 0,
    };
  });
}

export function addCursor() {
  return addLayer((scene, st) => {
    const d = Math.min(scene.duration, 2);
    return {
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
    };
  });
}

export function addImageLayer(asset: Asset) {
  return addLayer((scene, st) => {
    const nw = asset.width ?? st.width / 2;
    const nh = asset.height ?? st.height / 2;
    // Fit inside 60% of the frame without ever upscaling beyond natural size for bitmaps.
    const fit = Math.min((st.width * 0.6) / nw, (st.height * 0.6) / nh, asset.type === 'svg' ? Infinity : 1);
    return {
      ...baseLayer(asset.originalName.replace(/\.[^.]+$/, ''), scene, st),
      type: 'image',
      assetId: asset.id,
      width: Math.max(1, Math.round(nw * fit)),
      height: Math.max(1, Math.round(nh * fit)),
    };
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

// ---------------------------------------------------------------- settings

export function updateSettings(patch: Partial<Settings>) {
  S().commit((d) => {
    const st = d.settings;
    Object.assign(st, patch);
    if (patch.aspect && patch.aspect !== 'custom') {
      // Keep the long edge, change the ratio.
      const [aw, ah] = ASPECTS[patch.aspect];
      const long = Math.max(st.width, st.height);
      if (aw >= ah) {
        st.width = long;
        st.height = Math.round((long * ah) / aw / 2) * 2;
      } else {
        st.height = long;
        st.width = Math.round((long * aw) / ah / 2) * 2;
      }
    }
    if (patch.width !== undefined || patch.height !== undefined) {
      if (!patch.aspect) {
        const match = Object.entries(ASPECTS).find(([, [aw, ah]]) => Math.abs(st.width / st.height - aw / ah) < 0.002);
        st.aspect = (match?.[0] as Settings['aspect']) ?? 'custom';
      }
    }
    // Layers are never deleted by a settings change.
  });
  const { time, project } = S();
  if (time > project.settings.durationSec) S().setTime(project.settings.durationSec);
}

// ---------------------------------------------------------------- assets

async function sha256Hex(buf: ArrayBuffer) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function classify(file: File): Asset['type'] | null {
  const n = file.name.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(n)) return 'image';
  if (/\.svg$/.test(n)) return 'svg';
  if (/\.(ttf|otf|woff2?)$/.test(n)) return 'font';
  return null;
}

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
  if (!type) throw new Error(`${file.name}: unsupported file type (use PNG, JPG, WebP, SVG, TTF, OTF, WOFF, WOFF2)`);
  const bytes = await file.arrayBuffer();
  const { hash } = await api<{ hash: string }>('/api/assets', {
    method: 'POST',
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
  });
  if (hash !== (await sha256Hex(bytes))) throw new Error(`${file.name}: upload corrupted`);
  const safe = file.name.replace(/[^\w.\-]+/g, '_');
  const asset: Asset = { id: keepId ?? makeId('asset'), originalName: file.name, relativePath: `assets/${hash.slice(0, 8)}-${safe}`, type, hash };
  if (type === 'font') {
    asset.fontFamily = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, ' ').trim() || 'Imported font';
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
      if (!existing) S().commit((d) => void d.assets.push(asset));
      if (use.type === 'font') S().toast(`Font "${use.fontFamily}" added — pick it in a text layer's Font menu.`);
      else addImageLayer(use);
    } catch (e) {
      S().toast((e as Error).message, 'error');
    }
  }
}

/** Point an existing asset id at a new file; layers using it keep working. */
export async function relinkAsset(assetId: string, file: File) {
  try {
    const old = S().project.assets.find((a) => a.id === assetId);
    if (!old) return;
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

export async function saveProject(name?: string): Promise<boolean> {
  const target = name ?? S().projectName;
  if (!target) return false;
  try {
    const project = S().project;
    const r = await api<{ name: string }>(`/api/projects/${encodeURIComponent(target)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    });
    S().markSaved(project, r.name);
    S().toast(`Saved ${r.name}.motion`);
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
