// Shape properties (A3): type, sides/points, size, fill (solid or gradient), outline and line ends; plus the
// "Draw outline (trim)" section that shows only part of the outline.
import { useState } from 'react';
import { formatColor, parseColor } from '../../../shared/interpolate';
import { SHAPE_KINDS, type Scene, type ShapeKind, type ShapeLayer } from '../../../shared/schema';
import { useEditor } from '../../store';
import { NumberField, Row, Section, Select } from '../Fields';
import type { LayerFields } from './common';
import { FillRows } from './engineFields';

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  star: 'Star',
  polygon: 'Polygon',
  line: 'Line',
};

const LINE_ENDS: { value: ShapeLayer['lineCap']; label: string }[] = [
  { value: 'round', label: 'Round' },
  { value: 'butt', label: 'Flat' },
  { value: 'square', label: 'Square' },
];
const LINE_ENDS_TIP = "Shape of the outline's ends: Round, Flat (stops right at the end) or Square (sticks out by half the width).";

const TRIM_PROPS = ['trimStart', 'trimEnd', 'trimOffset'] as const;

/** Only part of the outline shows (now or at some keyframe): "Draw outline (trim)" is in use. */
export function trimInUse(layer: ShapeLayer): boolean {
  return layer.trimStart !== 0 || layer.trimEnd !== 1 || layer.trimOffset !== 0 || TRIM_PROPS.some((p) => !!layer.keyframes[p]?.length);
}

/** The shape has an outline at the playhead or at some keyframe. */
function hasOutline(layer: ShapeLayer, fields: LayerFields): boolean {
  return Number(fields.val('strokeWidth')) > 0 || !!layer.keyframes.strokeWidth?.some((k) => Number(k.value) > 0);
}

export function ShapeSection({ layer, fields }: { scene: Scene; layer: ShapeLayer; fields: LayerFields }) {
  const { num, color, setStatic } = fields;
  const line = layer.shape === 'line';
  const count = (label: string, tip: string) => (
    <Row label={label} tip={tip}>
      <NumberField value={layer.points} step={1} min={3} max={64} decimals={0} onCommit={(v) => setStatic({ points: Math.round(v) })} testId="prop-points" />
    </Row>
  );
  return (
    <Section title="Shape">
      <Row label="Type" tip="The outline drawn inside the layer's box.">
        <Select value={layer.shape} testId="prop-shape" options={SHAPE_KINDS.map((k) => ({ value: k, label: SHAPE_LABELS[k] }))} onChange={(shape) => setStatic({ shape })} />
      </Row>
      {layer.shape === 'polygon' && count('Sides', 'How many sides the polygon has (3–64).')}
      {layer.shape === 'star' && count('Points', 'How many points the star has (3–64).')}
      {layer.shape === 'star' && num('innerRadius', 'Inner size', { percent: true, min: 0, max: 100, step: 5, tip: "How far in the star's inner corners sit, as a percentage of its size. Smaller = spikier." })}
      {num('width', 'Width', { min: 1 })}
      {num('height', 'Height', { min: 1, tip: line ? 'Only sets how easy the line is to grab: the line runs across the middle of this box.' : undefined })}
      {layer.shape === 'rect' && num('cornerRadius', 'Corners', { min: 0 })}
      {!line && <FillRows layer={layer} fields={fields} colorProp="fill" />}
      {num('strokeWidth', line ? 'Line width' : 'Outline width', { min: 0, tip: line ? 'Thickness of the line, in pixels.' : undefined })}
      {(line || hasOutline(layer, fields)) && color('stroke', line ? 'Line colour' : 'Outline', line ? 'Colour of the line.' : undefined)}
      {(line || trimInUse(layer)) && (
        <Row label="Line ends" tip={LINE_ENDS_TIP}>
          <Select value={layer.lineCap} options={LINE_ENDS} onChange={(lineCap) => setStatic({ lineCap })} testId="prop-lineCap" tip={LINE_ENDS_TIP} />
        </Row>
      )}
    </Section>
  );
}

/** Same colour, fully see-through (keeps the colour so raising the alpha brings it back). */
const transparent = (c: string) => {
  const [r, g, b] = parseColor(c);
  return formatColor([r, g, b, 0]);
};

/**
 * "Draw outline (trim)": Start / End / Offset of the visible part of the outline, in % of its length (◆ each). Collapsed
 * unless in use. Without an outline it offers "Add outline" (a width sized for the frame and a see-through fill).
 */
export function TrimSection({ layer, fields }: { scene: Scene; layer: ShapeLayer; fields: LayerFields }) {
  const settings = useEditor((s) => s.project.settings);
  const { num, val, setAtPlayhead } = fields;
  // Open when the layer is selected with a trim in use; after that the user decides.
  const [open] = useState(() => trimInUse(layer));
  const addOutline = () => {
    const strokeWidth = Math.max(1, Math.round(0.01 * Math.min(settings.width, settings.height)));
    if (layer.shape === 'line') return setAtPlayhead({ strokeWidth });
    // One undo step: the outline plus a see-through fill, so the outline is what shows.
    setAtPlayhead({ strokeWidth, fill: transparent(String(val('fill'))), ...(layer.fillMode === 'linear' ? { fillMode: 'solid' } : {}) });
  };
  return (
    <Section title="Draw outline (trim)" defaultOpen={open} badge={trimInUse(layer) ? '●' : null} testId="trim-section">
      {!hasOutline(layer, fields) && (
        <div className="trim-hint" data-testid="trim-no-outline">
          <span>Only the outline is drawn — add one first</span>
          <button onClick={addOutline} title="Give the shape an outline and a see-through fill, so drawing the outline shows" data-testid="trim-add-outline">
            Add outline
          </button>
        </div>
      )}
      {num('trimStart', 'Start %', { percent: true, min: 0, max: 100, step: 1 })}
      {num('trimEnd', 'End %', { percent: true, min: 0, max: 100, step: 1 })}
      {num('trimOffset', 'Offset %', { percent: true, step: 1 })}
    </Section>
  );
}
