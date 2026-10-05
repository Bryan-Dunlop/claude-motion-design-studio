// Properties panel router: what the right-hand panel shows depends on the selection.
// Sections live in ./props/* so features can be added without editing one giant file.
import { findLayer, useEditor } from '../store';
import { AudioClipProps } from './props/AudioClipProps';
import { LayerProps } from './props/LayerProps';
import { PresetPanel } from './props/PresetPanel';
import { ProjectSettings } from './props/ProjectSettings';
import { SceneProps } from './props/SceneProps';
import { StaggerPanel } from './props/StaggerPanel';

export { RelinkButton } from './props/common';

export function Properties() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const time = useEditor((s) => s.time);
  const selected = selection.layerIds.map((id) => findLayer(project, id)).filter((x): x is NonNullable<typeof x> => !!x);
  const scene = project.scenes.find((s) => s.id === selection.sceneId);

  if (selected.length === 1) return <LayerProps scene={selected[0].scene} layer={selected[0].layer} time={time} />;
  if (selected.length > 1)
    return (
      <div className="props">
        <h3>{selected.length} layers selected</h3>
        <PresetPanel layerIds={selected.map((s) => s.layer.id)} />
        <StaggerPanel layers={selected.map((s) => s.layer)} />
      </div>
    );
  if (selection.audioIds.length > 0) return <AudioClipProps clipIds={selection.audioIds} />;
  return (
    <div className="props">
      {scene && <SceneProps scene={scene} />}
      <ProjectSettings />
    </div>
  );
}
