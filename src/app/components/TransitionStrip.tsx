// The hatched transition window at the start of a scene block in the timeline (owned by lane A; Timeline.tsx renders it).
import type { Project, Scene } from '../../shared/schema';
import { TRANSITION_LABELS, transitionPartner, transitionWindow } from '../../shared/transitions';

export function TransitionStrip({ project, scene, zoom }: { project: Project; scene: Scene; zoom: number }) {
  const w = transitionWindow(scene);
  if (!w) return null;
  const from = transitionPartner(project, scene);
  return (
    <div
      className="transition-strip"
      style={{ width: w.duration * zoom }}
      title={`${TRANSITION_LABELS[scene.transition.type]} from ${from ? from.name : 'the background'} · ${w.duration.toFixed(2)} s`}
      data-testid={`transition-strip-${scene.name}`}
    />
  );
}
