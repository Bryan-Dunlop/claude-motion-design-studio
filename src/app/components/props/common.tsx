// Shared building blocks for the Properties panel sections.
import { ANIMATABLE, type Layer, type Scene } from '../../../shared/schema';
import { relinkAsset, updateLayers } from '../../actions';
import { currentValue, keyAt, layerLocalTime, setProp, toggleKeyframe, useEditor } from '../../store';
import { ColorField, NumberField, Row } from '../Fields';

export const TIPS: Record<string, string> = {
  x: 'Horizontal position of the anchor point, in project pixels from the left edge.',
  y: 'Vertical position of the anchor point, in project pixels from the top edge.',
  scale: 'Size multiplier. 1 = original size, 2 = double, 0.5 = half.',
  rotation: 'Rotation in degrees around the anchor point. Positive = clockwise.',
  opacity: 'How see-through the layer is. 1 = solid, 0 = invisible.',
  fontSize: 'Text height in project pixels.',
  letterSpacing: 'Extra space between letters, in pixels. Negative tightens.',
  color: 'Text colour.',
  width: 'Width in project pixels (before scale).',
  height: 'Height in project pixels (before scale).',
  cornerRadius: 'Rounds the rectangle corners, in pixels.',
  fill: 'Fill colour of the shape.',
};

export function KfToggle({ scene, layer, prop }: { scene: Scene; layer: Layer; prop: string }) {
  const time = useEditor((s) => s.time);
  const fps = useEditor((s) => s.project.settings.fps);
  const keys = layer.keyframes[prop];
  const local = layerLocalTime(scene, layer, time);
  const on = !!keyAt(keys, local, fps);
  const animated = !!keys?.length;
  return (
    <button
      className={`kf-toggle ${on ? 'on' : animated ? 'animated' : ''}`}
      data-testid={`kf-toggle-${prop}`}
      title={
        on
          ? 'Remove the keyframe at the playhead'
          : animated
            ? 'Add a keyframe at the playhead (this property is animated)'
            : 'Start animating: add a keyframe for this property at the playhead'
      }
      onClick={() => useEditor.getState().commit((d) => toggleKeyframe(d, layer.id, prop, useEditor.getState().time))}
    >
      ◆
    </button>
  );
}

export interface NumOpts {
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  tip?: string;
}

/**
 * Field helpers for one layer. `num`/`color` render a row with a keyframe toggle (when the property is animatable)
 * and edit through `setProp`, so animated properties get a keyframe at the playhead.
 */
export function useLayerFields(scene: Scene, layer: Layer) {
  const commit = useEditor((s) => s.commit);
  const time = useEditor((s) => s.time);
  const animatable = ANIMATABLE[layer.type];
  const val = (p: string) => currentValue(scene, layer, p, time);
  const setP = (p: string, v: number | string) => commit((d) => setProp(d, layer.id, p, v, useEditor.getState().time));
  const setStatic = (patch: Record<string, unknown>) => updateLayers([layer.id], (l) => void Object.assign(l, patch));
  const kf = (p: string) => (animatable.includes(p) ? <KfToggle scene={scene} layer={layer} prop={p} /> : null);
  const num = (p: string, label: string, opts: NumOpts = {}) => (
    <Row label={label} tip={opts.tip ?? TIPS[p] ?? label} kf={kf(p)}>
      <NumberField value={Number(val(p))} step={opts.step ?? 1} min={opts.min} max={opts.max} decimals={opts.decimals} onCommit={(v) => setP(p, v)} testId={`prop-${p}`} />
    </Row>
  );
  const color = (p: string, label: string, tip?: string) => (
    <Row label={label} tip={tip ?? TIPS[p] ?? label} kf={kf(p)}>
      <ColorField value={String(val(p))} testId={`prop-${p}`} onLive={(v) => commit((d) => setProp(d, layer.id, p, v, useEditor.getState().time))} />
    </Row>
  );
  return { commit, time, val, setP, setStatic, kf, num, color };
}

export type LayerFields = ReturnType<typeof useLayerFields>;

export function RelinkButton({ assetId, name }: { assetId: string; name: string }) {
  return (
    <label className="button danger" title="The original file is missing. Pick a replacement file; layers using it keep their settings.">
      Missing: {name} — Relink…
      <input type="file" hidden accept=".png,.jpg,.jpeg,.webp,.svg,.ttf,.otf,.woff,.woff2" onChange={(e) => e.target.files?.[0] && relinkAsset(assetId, e.target.files[0])} />
    </label>
  );
}
