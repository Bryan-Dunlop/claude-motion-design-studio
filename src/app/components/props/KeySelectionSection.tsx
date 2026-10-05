// Easing for the keyframes selected in the timeline (or just added with ◆). Lane B (B2) extends this
// (delete button, copy/paste, multi-layer selections).
import type { Easing, Layer, Scene } from '../../../shared/schema';
import { findLayer, useEditor } from '../../store';
import { EasingPicker, Section } from '../Fields';

export function KeySelectionSection({ layer }: { scene: Scene; layer: Layer }) {
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const commit = useEditor((s) => s.commit);
  const mine = Object.entries(layer.keyframes).flatMap(([prop, keys]) => keys.filter((k) => selectedKeys.includes(k.id)).map((k) => ({ prop, k })));
  if (mine.length === 0) return null;
  const props = [...new Set(mine.map((m) => m.prop))];
  return (
    <Section title={`Keyframe easing (${mine.length} selected)`}>
      <p className="help">How the value travels from the selected keyframe{mine.length > 1 ? 's' : ''} to the next one ({props.join(', ')}).</p>
      <EasingPicker
        value={mine[0].k.easing}
        testId="kf-easing"
        onChange={(easing: Easing) =>
          commit((d) => {
            const l = findLayer(d, layer.id)?.layer;
            if (!l) return;
            for (const { prop, k } of mine) {
              const target = l.keyframes[prop]?.find((x) => x.id === k.id);
              if (target) target.easing = easing;
            }
          })
        }
      />
    </Section>
  );
}
