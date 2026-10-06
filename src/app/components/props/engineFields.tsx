// Extra Properties-panel controls used by the rendering-engine sections (effects, transitions, text animation, shapes).
// Fields.tsx and props/common.tsx stay the shared basics.
import type { ReactNode } from 'react';
import { propLabel } from '../../../shared/propLabels';
import type { ShapeLayer, TextLayer } from '../../../shared/schema';
import { gradientToFor } from '../../../shared/shapes';
import { NumberField, Row, Select } from '../Fields';
import type { LayerFields } from './common';

/** A checkbox on the Properties grid ("☐ Drop shadow"). */
export function CheckRow({ label, tip, checked, onChange, testId }: { label: string; tip: string; checked: boolean; onChange: (on: boolean) => void; testId: string }) {
  return (
    <div className="row check-row" title={tip}>
      <span className="row-kf" />
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
        {label}
      </label>
    </div>
  );
}

/** A read-only line of information in a section ("From: Hook"). */
export function InfoLine({ children, tip, testId }: { children: ReactNode; tip: string; testId: string }) {
  return (
    <p className="info-line" title={tip} data-testid={testId}>
      {children}
    </p>
  );
}

/** Seconds for display: at most two decimals, no trailing zeros (0.6, 1.25, 2). */
export const secs = (v: number) => String(Number(v.toFixed(2)));

/** A select whose options can be disabled (with their own tooltip, e.g. why "Draw on" is greyed out). */
export function OptionSelect<T extends string>({
  value,
  options,
  onChange,
  testId,
  tip,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  testId?: string;
  tip?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={testId} title={tip}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const FILL_MODES: { value: ShapeLayer['fillMode']; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'linear', label: 'Gradient' },
];
const FILL_TIP = 'A solid colour, or a gradient that blends from one colour to another.';

/**
 * Fill of a shape (`fill`) or text (`color`): `Fill` Solid | Gradient, then the colour, or From / To / Angle. Picking
 * Gradient when "To" equals the colour starts "To" from a darker or lighter shade, so the gradient shows at once.
 */
export function FillRows({ layer, fields, colorProp }: { layer: ShapeLayer | TextLayer; fields: LayerFields; colorProp: 'fill' | 'color' }) {
  const { color, val, setAtPlayhead } = fields;
  const pick = (mode: ShapeLayer['fillMode']) => {
    if (mode === layer.fillMode) return;
    if (mode === 'solid') return setAtPlayhead({ fillMode: 'solid' });
    const to = gradientToFor(String(val(colorProp)), String(val('gradientTo')));
    // One undo step for both.
    setAtPlayhead(to ? { fillMode: 'linear', gradientTo: to } : { fillMode: 'linear' });
  };
  return (
    <>
      <Row label="Fill" tip={FILL_TIP}>
        <Select value={layer.fillMode} options={FILL_MODES} onChange={pick} testId="prop-fillMode" tip={FILL_TIP} />
      </Row>
      {layer.fillMode === 'linear' ? (
        <>
          {color(colorProp, 'From', 'The colour the gradient starts with.')}
          {color('gradientTo', 'To')}
          <AngleRow fields={fields} />
        </>
      ) : (
        color(colorProp, 'Colour')
      )}
    </>
  );
}

/** Gradient angle (◆) with a small arrow that turns with it (0° points right, 90° down). */
function AngleRow({ fields }: { fields: LayerFields }) {
  const angle = Number(fields.val('gradientAngle'));
  const tip = propLabel('gradientAngle').tip;
  return (
    <Row label="Angle" tip={tip} kf={fields.kf('gradientAngle')}>
      <span className="angle-field">
        <NumberField value={angle} step={15} decimals={1} suffix="°" onCommit={(v) => fields.setP('gradientAngle', v)} testId="prop-gradientAngle" />
        <svg className="angle-arrow" viewBox="0 0 16 16" width="16" height="16" style={{ transform: `rotate(${angle}deg)` }} data-testid="gradient-arrow" aria-hidden="true">
          <path d="M2 8h11M9 4l4 4-4 4" />
        </svg>
      </span>
    </Row>
  );
}
