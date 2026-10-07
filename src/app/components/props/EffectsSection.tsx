// Blur, drop shadow and blend mode for any layer (A1). Collapsed unless an effect is in use ("Effects ●").
import { useState } from 'react';
import { shadowDefaults } from '../../../shared/effects';
import type { BlendMode, Layer, Scene } from '../../../shared/schema';
import { useEditor } from '../../store';
import { Row, Section, Select } from '../Fields';
import type { LayerFields } from './common';
import { CheckRow } from './engineFields';

const BLEND_GROUPS: { label: string; options: { value: BlendMode; label: string }[] }[] = [
  { label: 'Darken', options: [{ value: 'multiply', label: 'Multiply' }, { value: 'darken', label: 'Darken' }, { value: 'color-burn', label: 'Colour burn' }] },
  { label: 'Lighten', options: [{ value: 'screen', label: 'Screen' }, { value: 'lighten', label: 'Lighten' }, { value: 'color-dodge', label: 'Colour dodge' }] },
  { label: 'Contrast', options: [{ value: 'overlay', label: 'Overlay' }, { value: 'soft-light', label: 'Soft light' }, { value: 'hard-light', label: 'Hard light' }] },
  { label: 'Difference', options: [{ value: 'difference', label: 'Difference' }, { value: 'exclusion', label: 'Exclusion' }] },
  { label: 'Colour', options: [{ value: 'hue', label: 'Hue' }, { value: 'saturation', label: 'Saturation' }, { value: 'color', label: 'Colour' }, { value: 'luminosity', label: 'Luminosity' }] },
];

const BLEND_TIP = "How this layer mixes with what's behind it. Multiply darkens, Screen lightens.";

/** The layer uses an effect: a blur (now or at some keyframe), a drop shadow or a blend mode. */
export function effectsInUse(layer: Layer): boolean {
  const blurred = layer.blur > 0 || !!layer.keyframes.blur?.some((k) => Number(k.value) > 0);
  return blurred || layer.shadow || layer.blendMode !== 'normal';
}

export function EffectsSection({ layer, fields }: { scene: Scene; layer: Layer; fields: LayerFields }) {
  const settings = useEditor((s) => s.project.settings);
  const { num, color, pair, val, setAtPlayhead } = fields;
  // Open when the layer is selected with an effect in use; after that the user decides (it never snaps shut on untick).
  const [open] = useState(() => effectsInUse(layer));
  const active = effectsInUse(layer);

  const toggleShadow = (on: boolean) => {
    if (!on) return setAtPlayhead({ shadow: false });
    // Switched on with nothing set yet: a soft default shadow sized for the frame, in the same undo step.
    const blank = ['shadowBlur', 'shadowOffsetX', 'shadowOffsetY'].every((p) => Number(val(p)) === 0);
    setAtPlayhead(blank ? { shadow: true, ...shadowDefaults(settings) } : { shadow: true });
  };

  return (
    <Section title="Effects" defaultOpen={open} badge={active ? '●' : null} testId="effects-section">
      {num('blur', 'Blur', { min: 0, step: 1 })}
      <CheckRow label="Drop shadow" tip="A soft shadow behind the layer." checked={layer.shadow} onChange={toggleShadow} testId="effects-shadow" />
      {layer.shadow && (
        <>
          {color('shadowColor', 'Colour')}
          {num('shadowBlur', 'Softness', { min: 0, step: 1 })}
          {pair('shadowOffsetX', 'shadowOffsetY', 'Offset', { step: 1 })}
        </>
      )}
      <Row label="Blend" tip={BLEND_TIP}>
        <Select
          value={layer.blendMode}
          options={[{ value: 'normal', label: 'Normal' }]}
          groups={BLEND_GROUPS}
          onChange={(blendMode) => setAtPlayhead({ blendMode })}
          testId="prop-blendMode"
          tip={BLEND_TIP}
        />
      </Row>
    </Section>
  );
}
