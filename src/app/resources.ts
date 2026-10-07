// Decoded images / fonts for the current project, reloaded whenever the asset list changes.
import { useEffect } from 'react';
import { create } from 'zustand';
import { assetUrl } from '../shared/assetUrl';
import { createCanvasPool } from '../shared/canvas';
import { loadResources } from '../shared/loadResources';
import type { RenderResources } from '../shared/renderFrame';
import { useEditor } from './store';

/** Offscreen canvases reused by every preview frame (see src/shared/canvas.ts). */
const previewPool = createCanvasPool();

export const useResources = create<{ resources: RenderResources; loading: boolean }>(() => ({
  resources: { images: new Map(), canvasPool: previewPool },
  loading: false,
}));

export function useResourceLoader() {
  const assets = useEditor((s) => s.project.assets);
  const projectName = useEditor((s) => s.projectName);
  useEffect(() => {
    // The browser fetches a font weight or script the moment a frame first needs it (e.g. after typing Cyrillic or
    // picking a new weight) and draws that frame in a fallback font meanwhile: redraw once it has arrived.
    const redraw = () => useResources.setState((s) => ({ resources: { ...s.resources } }));
    document.fonts.addEventListener('loadingdone', redraw);
    return () => document.fonts.removeEventListener('loadingdone', redraw);
  }, []);
  useEffect(() => {
    let cancelled = false;
    useResources.setState({ loading: true });
    const project = useEditor.getState().project;
    loadResources({ ...project, assets }, (id) => assetUrl(projectName, assets.find((a) => a.id === id)!)).then((r) => {
      if (cancelled) return;
      const { missing: _missing, ...loaded } = r;
      useResources.setState({ resources: { ...loaded, canvasPool: previewPool }, loading: false });
      useEditor.getState().setMissingAssets(r.missing);
    });
    return () => {
      cancelled = true;
    };
  }, [assets, projectName]);
}
