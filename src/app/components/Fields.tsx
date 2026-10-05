// Small form controls. Text/number inputs commit on Enter/blur so typing "123" is one undo step.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { applyEasing, defaultEasing, EASING_LABELS } from '../../shared/easing';
import type { Easing } from '../../shared/schema';
import { useEditor } from '../store';

export function Row({ label, tip, children, kf }: { label: string; tip: string; children: ReactNode; kf?: ReactNode }) {
  return (
    <div className="row" title={tip}>
      <span className="row-kf">{kf}</span>
      <label className="row-label">{label}</label>
      <div className="row-ctl">{children}</div>
    </div>
  );
}

export function NumberField({
  value,
  onCommit,
  step = 1,
  min,
  max,
  testId,
  tip,
  decimals = 2,
}: {
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  testId?: string;
  tip?: string;
  decimals?: number;
}) {
  const shown = String(Math.round(value * 10 ** decimals) / 10 ** decimals);
  const [text, setText] = useState(shown);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(shown);
  }, [shown]);
  const commit = (raw: string) => {
    const v = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(v)) return setText(shown);
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    if (clamped !== value) onCommit(clamped);
    setText(String(Math.round(clamped * 10 ** decimals) / 10 ** decimals));
  };
  return (
    <input
      className="num"
      type="text"
      inputMode="decimal"
      value={text}
      title={tip}
      data-testid={testId}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        editing.current = false;
        commit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(shown);
          editing.current = false;
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const mult = e.shiftKey ? 10 : 1;
          const v = Math.round((value + (e.key === 'ArrowUp' ? step : -step) * mult) * 1e6) / 1e6;
          commit(String(v));
        }
      }}
    />
  );
}

export function TextField({ value, onCommit, multiline, testId }: { value: string; onCommit: (v: string) => void; multiline?: boolean; testId?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const props = {
    value: text,
    'data-testid': testId,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: () => text !== value && onCommit(text),
  };
  return multiline ? (
    <textarea rows={3} {...props} />
  ) : (
    <input type="text" {...props} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  );
}

/** Native colour picker; the whole pick (many input events) is one undo step. */
export function ColorField({ value, onLive, testId }: { value: string; onLive: (v: string) => void; testId?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const hex = value.length > 7 ? value.slice(0, 7) : value;
  useEffect(() => {
    const el = ref.current!;
    const end = () => useEditor.getState().endGesture();
    el.addEventListener('change', end);
    el.addEventListener('blur', end);
    return () => {
      el.removeEventListener('change', end);
      el.removeEventListener('blur', end);
    };
  }, []);
  return (
    <span className="color">
      <input
        ref={ref}
        type="color"
        value={hex}
        data-testid={testId}
        onChange={(e) => {
          useEditor.getState().beginGesture();
          onLive(e.target.value + (value.length > 7 ? value.slice(7) : ''));
        }}
      />
      <TextField value={value} onCommit={(v) => /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) && onLive(v)} />
    </span>
  );
}

export function Select<T extends string>({ value, options, onChange, testId }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; testId?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="section" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

/** Easing chooser with plain-language labels and a live curve preview. */
export function EasingPicker({ value, onChange, testId }: { value: Easing; onChange: (e: Easing) => void; testId?: string }) {
  const info = EASING_LABELS[value.type];
  return (
    <div className="easing">
      <Select
        value={value.type}
        testId={testId}
        options={(Object.keys(EASING_LABELS) as Easing['type'][]).map((t) => ({ value: t, label: EASING_LABELS[t].label }))}
        onChange={(t) => onChange(defaultEasing(t))}
      />
      <div className="easing-body">
        <CurvePreview easing={value} />
        <p className="help">{info.help}</p>
      </div>
      {value.type === 'cubicBezier' && (
        <div className="grid4">
          {(['x1', 'y1', 'x2', 'y2'] as const).map((k) => (
            <label key={k} title={k.startsWith('x') ? 'Handle time position (0–1)' : 'Handle value (can overshoot below 0 or above 1)'}>
              {k}
              <NumberField value={value[k]} step={0.05} min={k.startsWith('x') ? 0 : -2} max={k.startsWith('x') ? 1 : 3} onCommit={(v) => onChange({ ...value, [k]: v })} />
            </label>
          ))}
        </div>
      )}
      {value.type === 'spring' && (
        <div className="grid3">
          <label title="Stiffness: higher = snappier, faster motion">
            Stiffness
            <NumberField value={value.stiffness} step={10} min={1} max={2000} onCommit={(v) => onChange({ ...value, stiffness: v })} testId="spring-stiffness" />
          </label>
          <label title="Damping: higher = less bounce. Low values wobble longer">
            Damping
            <NumberField value={value.damping} step={1} min={0} max={500} onCommit={(v) => onChange({ ...value, damping: v })} testId="spring-damping" />
          </label>
          <label title="Mass: higher = heavier, slower, more overshoot">
            Mass
            <NumberField value={value.mass} step={0.1} min={0.05} max={50} onCommit={(v) => onChange({ ...value, mass: v })} />
          </label>
        </div>
      )}
    </div>
  );
}

export function CurvePreview({ easing, seconds = 1 }: { easing: Easing; seconds?: number }) {
  const W = 120;
  const H = 70;
  const pts: string[] = [];
  let minY = 0;
  let maxY = 1;
  const vals: number[] = [];
  for (let i = 0; i <= 60; i++) {
    const v = applyEasing(easing, i / 60, seconds);
    vals.push(v);
    minY = Math.min(minY, v);
    maxY = Math.max(maxY, v);
  }
  const pad = 6;
  vals.forEach((v, i) => {
    const x = pad + (i / 60) * (W - 2 * pad);
    const y = H - pad - ((v - minY) / (maxY - minY)) * (H - 2 * pad);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  const y0 = H - pad - ((0 - minY) / (maxY - minY)) * (H - 2 * pad);
  const y1 = H - pad - ((1 - minY) / (maxY - minY)) * (H - 2 * pad);
  return (
    <svg className="curve" width={W} height={H} data-testid="easing-curve">
      <line x1={pad} x2={W - pad} y1={y0} y2={y0} className="guide" />
      <line x1={pad} x2={W - pad} y1={y1} y2={y1} className="guide" />
      <polyline points={pts.join(' ')} className="curve-line" />
    </svg>
  );
}
