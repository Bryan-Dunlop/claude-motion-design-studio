import type { Layer, Scene } from '../../../shared/schema';
import { layerLocalTime, useEditor } from '../../store';
import { NumberField, Row, Section, TextField } from '../Fields';
import { useLayerFields } from './common';
import { CursorPanel } from './CursorPanel';
import { EffectsSection } from './EffectsSection';
import { ImageSection } from './ImageSection';
import { KeySelectionSection } from './KeySelectionSection';
import { PresetPanel } from './PresetPanel';
import { ShapeSection } from './ShapeSection';
import { TextAnimSection } from './TextAnimSection';
import { TextSection } from './TextSection';

export function LayerProps({ scene, layer, time }: { scene: Scene; layer: Layer; time: number }) {
  const fps = useEditor((s) => s.project.settings.fps);
  const fields = useLayerFields(scene, layer);
  const { num, setStatic } = fields;
  const local = layerLocalTime(scene, layer, time);
  const active = local >= 0 && local < layer.duration;

  return (
    <div className="props">
      <h3>
        {layer.name} <span className="muted">· {layer.type}</span>
      </h3>
      {!active && <p className="warn">The playhead is outside this layer's time range, so it isn't visible right now.</p>}
      <KeySelectionSection scene={scene} layer={layer} />
      <Section title="Layer">
        <Row label="Name" tip="Layer name shown in the Layers list and timeline.">
          <TextField value={layer.name} onCommit={(v) => setStatic({ name: v || layer.name })} testId="prop-name" />
        </Row>
        <Row label="Start" tip="When the layer appears, in seconds after its scene starts.">
          <NumberField value={layer.start} step={0.1} min={0} onCommit={(v) => setStatic({ start: v })} testId="prop-start" />
        </Row>
        <Row label="Duration" tip="How long the layer stays on screen, in seconds.">
          <NumberField value={layer.duration} step={0.1} min={1 / fps} onCommit={(v) => setStatic({ duration: v })} testId="prop-duration" />
        </Row>
      </Section>

      <Section title="Transform">
        {layer.type !== 'cursor' && num('x', 'X', { step: 1 })}
        {layer.type !== 'cursor' && num('y', 'Y', { step: 1 })}
        {num('scale', 'Scale', { step: 0.05, min: 0, decimals: 3 })}
        {layer.type !== 'cursor' && num('rotation', 'Rotation', { step: 1 })}
        {num('opacity', 'Opacity', { step: 0.05, min: 0, max: 1, decimals: 3 })}
        {layer.type !== 'cursor' && (
          <Row label="Anchor" tip="The pivot point for rotation and scaling, as a fraction of the layer box (0.5, 0.5 = centre).">
            <span className="pair">
              <NumberField value={layer.anchorX} step={0.1} decimals={3} onCommit={(v) => setStatic({ anchorX: v })} />
              <NumberField value={layer.anchorY} step={0.1} decimals={3} onCommit={(v) => setStatic({ anchorY: v })} />
            </span>
          </Row>
        )}
      </Section>

      {layer.type === 'text' && <TextSection scene={scene} layer={layer} fields={fields} />}
      {layer.type === 'text' && <TextAnimSection scene={scene} layer={layer} fields={fields} />}
      {layer.type === 'shape' && <ShapeSection scene={scene} layer={layer} fields={fields} />}
      {layer.type === 'image' && <ImageSection scene={scene} layer={layer} fields={fields} />}
      {layer.type === 'cursor' && <CursorPanel layer={layer} scene={scene} />}

      <EffectsSection scene={scene} layer={layer} fields={fields} />

      <PresetPanel layerIds={[layer.id]} />
    </div>
  );
}
