import type { Scene } from '../../../shared/schema';
import { resizeScene } from '../../sceneTiming';
import { useEditor } from '../../store';
import { NumberField, Row, Section, TextField } from '../Fields';
import { SceneBackgroundSection, TransitionSection } from './SceneExtras';

export function SceneProps({ scene }: { scene: Scene }) {
  const commit = useEditor((s) => s.commit);
  const fps = useEditor((s) => s.project.settings.fps);
  const set = (k: 'start' | 'duration', v: number) =>
    commit((d) => {
      const s = d.scenes.find((x) => x.id === scene.id);
      if (!s) return;
      if (k === 'duration') resizeScene(s, Math.max(1 / fps, v), fps);
      else s.start = Math.max(0, v);
    });
  return (
    <>
      <Section title={`Scene: ${scene.name}`}>
        <Row label="Name" tip="Scene name (also editable in the Scenes list).">
          <TextField value={scene.name} onCommit={(v) => commit((d) => void (d.scenes.find((x) => x.id === scene.id)!.name = v || scene.name))} />
        </Row>
        <Row label="Start" tip="When the scene begins, in seconds from the start of the video.">
          <NumberField value={scene.start} step={0.1} min={0} onCommit={(v) => set('start', v)} testId="scene-start" />
        </Row>
        <Row
          label="Duration"
          tip="How long the scene lasts, in seconds. Layers that would run past a shorter scene end there, so their exit animations still play; layers that end with the scene follow it when it gets longer."
        >
          <NumberField value={scene.duration} step={0.1} min={0.01} onCommit={(v) => set('duration', v)} testId="scene-duration" />
        </Row>
      </Section>
      <SceneBackgroundSection scene={scene} />
      <TransitionSection scene={scene} />
    </>
  );
}
