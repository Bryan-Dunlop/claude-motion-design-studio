// Scene background colour and "Transition into this scene" (A1).
import type { Draft } from 'immer';
import type { Project, Scene, Transition } from '../../../shared/schema';
import { DIRECTION_LABELS, DIRECTIONAL, TRANSITION_LABELS, transitionPartner, transitionWindow } from '../../../shared/transitions';
import { useEditor } from '../../store';
import { ColorField, EasingPicker, NumberField, Row, Section, Select } from '../Fields';
import { CheckRow, InfoLine, secs } from './engineFields';

const STYLES = Object.keys(TRANSITION_LABELS) as Transition['type'][];
const DIRECTIONS = Object.keys(DIRECTION_LABELS) as Transition['direction'][];

function editScene(sceneId: string, fn: (s: Draft<Scene>) => void) {
  useEditor.getState().commit((d) => {
    const s = d.scenes.find((x) => x.id === sceneId);
    if (s) fn(s);
  });
}

export function SceneBackgroundSection({ scene }: { scene: Scene }) {
  const projectBackground = useEditor((s) => s.project.settings.background);
  const own = scene.background !== null;
  return (
    <Section title="Background" testId="scene-background-section">
      <CheckRow
        label="Own background colour"
        tip="Give this scene its own background colour instead of the project's."
        checked={own}
        onChange={(on) => editScene(scene.id, (s) => void (s.background = on ? projectBackground : null))}
        testId="scene-own-background"
      />
      {own && (
        <Row label="Colour" tip="Fills the whole frame behind this scene's layers.">
          <ColorField value={scene.background!} onLive={(v) => editScene(scene.id, (s) => void (s.background = v))} testId="scene-background" />
        </Row>
      )}
    </Section>
  );
}

/** The scene that starts first (ties: first in the list): "Apply to all" leaves it alone. */
function firstScene(project: Project): Scene | undefined {
  return project.scenes.reduce<Scene | undefined>((a, s) => (!a || s.start < a.start ? s : a), undefined);
}

export function TransitionSection({ scene }: { scene: Scene }) {
  const project = useEditor((s) => s.project);
  const tr = scene.transition;
  const set = (patch: Partial<Transition>) => editScene(scene.id, (s) => void Object.assign(s.transition, patch));
  const win = transitionWindow(scene);
  const from = transitionPartner(project, scene);
  const applyToAll = () => {
    const firstId = firstScene(project)?.id;
    useEditor.getState().commit((d) => {
      for (const s of d.scenes) if (s.id !== firstId) s.transition = { type: tr.type, duration: tr.duration, direction: tr.direction, easing: { ...tr.easing } };
    });
  };
  return (
    <Section title="Transition into this scene" testId="transition-section">
      <Row label="Style" tip="How this scene appears: a hard cut, or a short transition from the scene before it.">
        <Select value={tr.type} options={STYLES.map((t) => ({ value: t, label: TRANSITION_LABELS[t] }))} onChange={(type) => set({ type })} testId="transition-style" />
      </Row>
      {tr.type !== 'none' && (
        <>
          <Row label="Length (s)" tip="Plays during the first N s of this scene. The previous scene holds its last frame unless they overlap.">
            <NumberField value={tr.duration} step={0.1} min={0.05} onCommit={(duration) => set({ duration })} testId="transition-length" />
          </Row>
          {win && win.duration < tr.duration - 1e-9 && <p className="help">Shortened to the scene's length ({secs(win.duration)} s).</p>}
          {DIRECTIONAL.includes(tr.type) && (
            <Row label="Direction" tip="Which way the new scene moves across the frame.">
              <Select value={tr.direction} options={DIRECTIONS.map((d) => ({ value: d, label: DIRECTION_LABELS[d] }))} onChange={(direction) => set({ direction })} testId="transition-direction" />
            </Row>
          )}
          <div title="How the transition speeds up and slows down.">
            <EasingPicker value={tr.easing} onChange={(easing) => set({ easing })} testId="transition-easing" />
          </div>
          <InfoLine tip="The scene this one transitions from: the one that ends as this one starts." testId="transition-from">
            From: {from ? from.name : 'background (no scene before)'}
          </InfoLine>
        </>
      )}
      <div className="btn-row">
        {tr.type !== 'none' && (
          <button
            title="Play just this transition, from half a second before to half a second after"
            onClick={() => useEditor.getState().previewRange(scene.start - 0.5, scene.start + (win?.duration ?? 0) + 0.5)}
            data-testid="transition-preview"
          >
            ▶ Preview
          </button>
        )}
        {project.scenes.length > 1 && (
          <button title="Use this transition (style, length, direction and easing) for every scene except the first" onClick={applyToAll} data-testid="transition-apply-all">
            Apply to all scenes
          </button>
        )}
      </div>
    </Section>
  );
}
