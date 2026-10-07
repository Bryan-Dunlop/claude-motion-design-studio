// Shared building blocks for the Properties panel sections.
import { makeId } from '../../../shared/presets';
import { PROP_LABELS, propLabel } from '../../../shared/propLabels';
import { ANIMATABLE, type Asset, type Layer, type Scene } from '../../../shared/schema';
import { AUDIO_EXTS, FONT_EXTS, IMAGE_EXTS, relinkAsset, updateLayers } from '../../actions';
import { currentValue, findLayer, keyAt, layerLocalTime, setProp, toggleKeyframe, useEditor } from '../../store';
import { ColorField, NumberField, Row } from '../Fields';

/** Tooltips per property (from the shared label table, so Properties and the timeline use the same words). */
export const TIPS: Record<string, string> = Object.fromEntries(Object.entries(PROP_LABELS).map(([k, v]) => [k, v.tip]));

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
      onClick={() => {
        const st = useEditor.getState();
        const id = makeId('kf');
        let result: ReturnType<typeof toggleKeyframe> = null;
        st.commit((d) => void (result = toggleKeyframe(d, layer.id, prop, st.time, id)));
        // A new keyframe becomes the selection, so its easing can be edited right away.
        if (result === 'added') st.selectKeys([id]);
      }}
    >
      ◆
    </button>
  );
}

export interface NumOpts {
  /** Step/min/max are in displayed units (percent when `percent` is set). */
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  tip?: string;
  /** Edit a 0..1 fraction as 0..100 %. */
  percent?: boolean;
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
  const numberField = (p: string, opts: NumOpts) => (
    <NumberField
      value={Number(val(p))}
      step={opts.step ?? 1}
      min={opts.min}
      max={opts.max}
      decimals={opts.decimals ?? (opts.percent ? 1 : 2)}
      displayScale={opts.percent ? 100 : 1}
      suffix={opts.percent ? '%' : undefined}
      onCommit={(v) => setP(p, v)}
      testId={`prop-${p}`}
    />
  );
  /** A number row; `label` defaults to the shared label for the property. */
  const num = (p: string, label: string = propLabel(p).label, opts: NumOpts = {}) => (
    <Row label={label} tip={opts.tip ?? TIPS[p] ?? label} kf={kf(p)}>
      {numberField(p, opts)}
    </Row>
  );
  /** Two number fields on one row (e.g. shadow offset X/Y), each with its own ◆ keyframe toggle. */
  const pair = (px: string, py: string, label: string, opts: NumOpts = {}) => (
    <Row label={label} tip={opts.tip ?? `${TIPS[px] ?? px} / ${TIPS[py] ?? py}`}>
      <span className="pair kf-pair">
        {kf(px)}
        {numberField(px, opts)}
        {kf(py)}
        {numberField(py, opts)}
      </span>
    </Row>
  );
  const color = (p: string, label: string = propLabel(p).label, tip?: string) => (
    <Row label={label} tip={tip ?? TIPS[p] ?? label} kf={kf(p)}>
      <ColorField value={String(val(p))} testId={`prop-${p}`} onLive={(v) => commit((d) => setProp(d, layer.id, p, v, useEditor.getState().time))} />
    </Row>
  );
  /**
   * Write several properties at once as ONE undo step. Animatable properties go through setProp (keyframe at the
   * playhead when animated); everything else is set statically. Use this for any button that changes values
   * ("Natural size", "Add outline", drop-shadow defaults…) — never write an animatable property statically.
   */
  const setAtPlayhead = (patch: Record<string, number | string | boolean | null>) =>
    commit((d) => {
      const t = useEditor.getState().time;
      const hit = findLayer(d, layer.id);
      if (!hit) return;
      for (const [p, v] of Object.entries(patch)) {
        if (animatable.includes(p) && (typeof v === 'number' || typeof v === 'string')) setProp(d, layer.id, p, v, t);
        else (hit.layer as unknown as Record<string, unknown>)[p] = v;
      }
    });
  return { commit, time, val, setP, setStatic, setAtPlayhead, kf, num, pair, color };
}

export type LayerFields = ReturnType<typeof useLayerFields>;

export function RelinkButton({ assetId, name, type }: { assetId: string; name: string; type?: Asset['type'] }) {
  const accept = type === 'audio' ? AUDIO_EXTS : type === 'font' ? FONT_EXTS : type ? IMAGE_EXTS : `${IMAGE_EXTS},${FONT_EXTS},${AUDIO_EXTS}`;
  return (
    <label
      className="button danger"
      title={`The original file is missing. Pick a replacement file; ${type === 'audio' ? 'clips' : 'layers'} using it keep their settings.`}
      data-testid={`relink-${name}`}
    >
      Missing: {name} — Relink…
      <input type="file" hidden accept={accept} onChange={(e) => e.target.files?.[0] && relinkAsset(assetId, e.target.files[0])} />
    </label>
  );
}
