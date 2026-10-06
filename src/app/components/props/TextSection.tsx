import { BUILTIN_FONTS } from '../../../shared/loadResources';
import type { Scene, TextLayer } from '../../../shared/schema';
import { useEditor } from '../../store';
import { NumberField, Row, Section, Select, TextField } from '../Fields';
import type { LayerFields } from './common';
import { FillRows } from './engineFields';

export function TextSection({ layer, fields }: { scene: Scene; layer: TextLayer; fields: LayerFields }) {
  const assets = useEditor((s) => s.project.assets);
  const { num, color, val, setStatic } = fields;
  // Outline colour only matters once there is an outline (now or at some keyframe).
  const outlined = Number(val('strokeWidth')) > 0 || !!layer.keyframes.strokeWidth?.some((k) => Number(k.value) > 0);
  return (
    <Section title="Typography">
      <Row label="Text" tip="The words shown. Press Enter for a new line.">
        <TextField multiline value={layer.content} onCommit={(v) => setStatic({ content: v })} testId="prop-content" />
      </Row>
      <Row label="Font" tip="Font family. Import TTF/OTF/WOFF files to add more.">
        <Select
          value={layer.fontFamily}
          testId="prop-fontFamily"
          options={[...BUILTIN_FONTS, ...assets.filter((a) => a.type === 'font').map((a) => a.fontFamily!)]
            .filter((v, i, a) => a.indexOf(v) === i)
            .map((f) => ({ value: f, label: f }))}
          onChange={(fontFamily) => setStatic({ fontFamily })}
        />
      </Row>
      {num('fontSize', 'Size', { step: 2, min: 1 })}
      <Row label="Weight" tip="How bold the text is (100 thin – 900 black).">
        <Select
          value={String(layer.fontWeight)}
          options={['300', '400', '500', '600', '700', '800', '900'].map((w) => ({ value: w, label: w }))}
          onChange={(w) => setStatic({ fontWeight: Number(w) })}
        />
      </Row>
      <Row label="Line height" tip="Space between lines, as a multiple of the font size.">
        <NumberField value={layer.lineHeight} step={0.05} min={0.5} max={4} onCommit={(v) => setStatic({ lineHeight: v })} />
      </Row>
      {num('letterSpacing', 'Spacing', { step: 0.5 })}
      <Row label="Align" tip="How lines line up with each other.">
        <Select
          value={layer.align}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ]}
          onChange={(align) => setStatic({ align })}
        />
      </Row>
      <FillRows layer={layer} fields={fields} colorProp="color" />
      {num('strokeWidth', 'Outline width', { min: 0, tip: 'Outline around the letters, in pixels. 0 = no outline.' })}
      {outlined && color('stroke', 'Outline', 'Colour of the outline around the letters.')}
    </Section>
  );
}
