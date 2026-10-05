import { SHAPE_KINDS, type Scene, type ShapeKind, type ShapeLayer } from '../../../shared/schema';
import { Row, Section, Select } from '../Fields';
import type { LayerFields } from './common';

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  star: 'Star',
  polygon: 'Polygon',
  line: 'Line',
};

export function ShapeSection({ layer, fields }: { scene: Scene; layer: ShapeLayer; fields: LayerFields }) {
  const { num, color, setStatic } = fields;
  return (
    <Section title="Shape">
      <Row label="Type" tip="The outline drawn inside the layer's box.">
        <Select value={layer.shape} testId="prop-shape" options={SHAPE_KINDS.map((k) => ({ value: k, label: SHAPE_LABELS[k] }))} onChange={(shape) => setStatic({ shape })} />
      </Row>
      {num('width', 'Width', { min: 1 })}
      {num('height', 'Height', { min: 1 })}
      {layer.shape === 'rect' && num('cornerRadius', 'Corners', { min: 0 })}
      {color('fill', 'Fill')}
      {color('stroke', 'Outline')}
      {num('strokeWidth', 'Outline width', { min: 0 })}
    </Section>
  );
}
