// Decoded images / fonts for the current project, reloaded whenever the asset list changes.
import { useEffect } from 'react';
import { create } from 'zustand';
import { assetUrl } from '../shared/assetUrl';
import { loadResources } from '../shared/loadResources';
import type { RenderResources } from '../shared/renderFrame';
import { useEditor } from './store';

export const useResources = create<{ resources: RenderResources; loading: boolean }>(() => ({
  resources: { images: new Map() },
  loading: false,
}));

export function useResourceLoader() {
  const assets = useEditor((s) => s.project.assets);
  const projectName = useEditor((s) => s.projectName);
  useEffect(() => {
    let cancelled = false;
    useResources.setState({ loading: true });
    const project = useEditor.getState().project;
    loadResources({ ...project, assets }, (id) => assetUrl(projectName, assets.find((a) => a.id === id)!)).then((r) => {
      if (cancelled) return;
      useResources.setState({ resources: { images: r.images }, loading: false });
      useEditor.getState().setMissingAssets(r.missing);
    });
    return () => {
      cancelled = true;
    };
  }, [assets, projectName]);
}
