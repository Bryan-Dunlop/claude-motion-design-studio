import { useState } from 'react';
import { applyPreset, DEFAULT_PRESET, presetApplies, type PresetParams } from '../../../shared/presets';
import { DIRECTION_LABELS } from '../../../shared/transitions';
import { findLayer, useEditor } from '../../store';
import { EasingPicker, NumberField, Row, Section, Select } from '../Fields';

export function PresetPanel({ layerIds }: { layerIds: string[] }) {
  const [p, setP] = useState<PresetParams>(DEFAULT_PRESET);
  const commit = useEditor((s) => s.commit);
  const apply = () => {
    let skipped = 0;
    commit((d) => {
      for (const id of layerIds) {
        const hit = findLayer(d, id);
        if (!hit) continue;
        if (!presetApplies(hit.layer, p)) skipped++;
        else hit.layer.keyframes = applyPreset(hit.layer, p);
      }
    });
    if (skipped) useEditor.getState().toast(`${skipped} layer${skipped > 1 ? 's' : ''} skipped: this effect isn't available on ${skipped > 1 ? 'them' : 'it'}.`);
  };
  const remove = () =>
    commit((d) => {
      for (const id of layerIds) {
        const l = findLayer(d, id)?.layer;
        if (!l) continue;
        for (const [prop, keys] of Object.entries(l.keyframes)) {
          const kept = keys.filter((k) => k.source !== `preset:${p.phase}`);
          if (kept.length) l.keyframes[prop] = kept;
          else delete l.keyframes[prop];
        }
      }
    });
  return (
    <Section title="Animation presets" defaultOpen={false}>
      <p className="help">Generates normal keyframes you can edit afterwards. Applying again replaces the previous preset of the same phase.</p>
      <Row label="Effect" tip="What changes: position (slide), opacity (fade) or size (scale).">
        <Select
          value={p.kind}
          testId="preset-kind"
          options={[
            { value: 'fade', label: 'Fade' },
            { value: 'slide', label: 'Slide' },
            { value: 'scale', label: 'Scale' },
          ]}
          onChange={(kind) => setP({ ...p, kind })}
        />
      </Row>
      <Row label="Phase" tip="In = at the layer's start, Out = at the layer's end.">
        <Select
          value={p.phase}
          testId="preset-phase"
          options={[
            { value: 'in', label: 'In (entrance)' },
            { value: 'out', label: 'Out (exit)' },
          ]}
          onChange={(phase) => setP({ ...p, phase })}
        />
      </Row>
      {p.kind === 'slide' && (
        <>
          <Row label="Direction" tip="Which way the layer moves.">
            <Select
              value={p.direction}
              testId="preset-direction"
              options={(['up', 'down', 'left', 'right'] as const).map((d) => ({ value: d, label: DIRECTION_LABELS[d] }))}
              onChange={(direction) => setP({ ...p, direction })}
            />
          </Row>
          <Row label="Distance" tip="How far it travels, in project pixels.">
            <NumberField value={p.distance} step={10} min={0} onCommit={(distance) => setP({ ...p, distance })} />
          </Row>
        </>
      )}
      <Row label="Delay" tip="Seconds after the layer starts (in) or before it ends (out).">
        <NumberField value={p.delay} step={0.1} min={0} onCommit={(delay) => setP({ ...p, delay })} />
      </Row>
      <Row label="Duration" tip="How long the animation takes, in seconds.">
        <NumberField value={p.duration} step={0.1} min={0.01} onCommit={(duration) => setP({ ...p, duration })} testId="preset-duration" />
      </Row>
      <EasingPicker value={p.easing} onChange={(easing) => setP({ ...p, easing })} />
      <div className="btn-row">
        <button className="primary" onClick={apply} data-testid="preset-apply" title="Generate keyframes on the selected layer(s)">
          Apply
        </button>
        <button onClick={remove} title="Remove keyframes created by this phase's preset">
          Remove {p.phase} preset
        </button>
      </div>
    </Section>
  );
}
