// Easing and Delete for the keyframes selected in the timeline (or just added with ◆), on one layer or several.
// Selected keyframes always belong to selected layers (store invariant), so this reads the whole selection.
import { propLabel } from '../../../shared/propLabels';
import type { Easing, Layer, Scene } from '../../../shared/schema';
import { deleteKeys } from '../../actions';
import { useEditor } from '../../store';
import { EasingPicker, Section } from '../Fields';

export function KeySelectionSection(_props: { scene?: Scene; layer?: Layer }) {
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const scenes = useEditor((s) => s.project.scenes);
  const commit = useEditor((s) => s.commit);
  const ids = new Set(selectedKeys);
  const picked = scenes.flatMap((s) => s.layers.flatMap((l) => Object.entries(l.keyframes).flatMap(([prop, keys]) => keys.filter((k) => ids.has(k.id)).map((k) => ({ prop, k })))));
  if (picked.length === 0) return null;
  const n = picked.length;
  const props = [...new Set(picked.map((m) => propLabel(m.prop).long))];
  const setEasing = (easing: Easing) =>
    commit((d) => {
      for (const s of d.scenes) for (const l of s.layers) for (const keys of Object.values(l.keyframes)) for (const k of keys) if (ids.has(k.id)) k.easing = easing;
    });
  return (
    <Section title={`Keyframe easing (${n} selected)`} testId="kf-selection">
      <p className="help">
        How the value travels from the selected keyframe{n > 1 ? 's' : ''} to the next one ({props.join(', ')}).
      </p>
      <EasingPicker value={picked[0].k.easing} testId="kf-easing" onChange={setEasing} />
      <div className="kf-actions">
        <span className="help">Reuse this motion: Ctrl+C, select another layer, Ctrl+V.</span>
        <button className="danger" onClick={() => deleteKeys(selectedKeys)} title="Delete the selected keyframes (Delete key). The layer stays." data-testid="kf-delete">
          Delete {n > 1 ? `${n} keyframes` : 'keyframe'}
        </button>
      </div>
    </Section>
  );
}
