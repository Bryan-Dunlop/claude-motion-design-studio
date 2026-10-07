// "Text animation" (A2): animate a text layer in / out letter by letter, word by word or line by line. Collapsed unless
// in use. Per phase: a Style menu + ▶ Preview, and the raw settings under a collapsed "Customise".
import { useState } from 'react';
import type { Scene, TextAnim, TextLayer } from '../../../shared/schema';
import { findStyle, matchStyle, phaseWindow, styleAnim, stylesFor, type Phase } from '../../../shared/textAnim';
import { useEditor } from '../../store';
import { EasingPicker, NumberField, Row, Section, Select } from '../Fields';
import type { LayerFields } from './common';
import { CheckRow } from './engineFields';

type Unit = TextAnim['unit'];
type Effect = TextAnim['effect'];
type Order = TextAnim['order'];

const UNITS: { value: Unit; label: string }[] = [
  { value: 'char', label: 'Letters' },
  { value: 'word', label: 'Words' },
  { value: 'line', label: 'Lines' },
];
const UNIT_NOUN: Record<Unit, string> = { char: 'letter', word: 'word', line: 'line' };
/** Gap that suits each unit (the styles' values): switching "Animate by" uses it unless the gap was changed. */
const UNIT_GAP: Record<Unit, number> = { char: 0.03, word: 0.08, line: 0.15 };

const EFFECTS: { value: Effect; label: string }[] = [
  { value: 'fade', label: 'Fade' },
  { value: 'rise', label: 'Move up' },
  { value: 'drop', label: 'Move down' },
  { value: 'scale', label: 'Grow' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'blur', label: 'Blur' },
];

const ORDERS: { value: Order; label: string }[] = [
  { value: 'forward', label: 'First to last' },
  { value: 'reverse', label: 'Last to first' },
  { value: 'center', label: 'Middle out' },
  { value: 'edges', label: 'Edges in' },
  { value: 'random', label: 'Random' },
];

const ORDER_TIP = 'Which piece goes first. Middle out starts in the centre, Edges in at both ends.';
const UNIT_TIP = 'Move the text letter by letter, word by word or line by line.';

const isMove = (e: Effect) => e === 'rise' || e === 'drop';

const TIPS: Record<Phase, Record<string, string>> = {
  in: {
    heading: 'Animate the text as the layer appears.',
    style: 'How the text appears at the start of the layer, piece by piece.',
    preview: 'Play the start of this layer once to see the animation',
    effect: 'What each piece does as it appears. Move up/down: slides into place. Grow: scales up from nothing. Typewriter: pops in, one at a time.',
    duration: 'How long each piece takes to appear, in seconds.',
    delay: 'Wait this many seconds after the layer starts.',
    distance: 'How far each piece travels into place, in project pixels.',
    blur: 'How blurry each piece starts, in project pixels.',
    caret: 'Show a blinking text cursor while typing.',
  },
  out: {
    heading: 'Animate the text as the layer disappears.',
    style: 'How the text leaves at the end of the layer, piece by piece.',
    preview: 'Play the end of this layer once to see the animation',
    effect: 'What each piece does as it leaves. Move up/down: keeps moving that way as it fades. Grow: shrinks away. Typewriter: deleted, one at a time.',
    duration: 'How long each piece takes to leave, in seconds.',
    delay: 'Finish this many seconds before the layer ends.',
    distance: 'How far each piece travels as it leaves, in project pixels.',
    blur: 'How blurry each piece gets as it leaves, in project pixels.',
    caret: 'Show a blinking text cursor while deleting.',
  },
};

export const textAnimInUse = (layer: TextLayer) => !!(layer.textIn || layer.textOut);

export function TextAnimSection({ scene, layer, fields }: { scene: Scene; layer: TextLayer; fields: LayerFields }) {
  // Open when the layer is selected with an animation in use; after that the user decides.
  const [open] = useState(() => textAnimInUse(layer));
  return (
    <Section title="Text animation" defaultOpen={open} badge={textAnimInUse(layer) ? '●' : null} testId="textanim-section">
      <PhaseControls phase="in" scene={scene} layer={layer} fields={fields} />
      <PhaseControls phase="out" scene={scene} layer={layer} fields={fields} />
    </Section>
  );
}

function PhaseControls({ phase, scene, layer, fields }: { phase: Phase; scene: Scene; layer: TextLayer; fields: LayerFields }) {
  const anim = phase === 'in' ? layer.textIn : layer.textOut;
  const tips = TIPS[phase];
  const id = (name: string) => `textanim-${phase}-${name}`;
  const fontSize = Number(fields.val('fontSize')) || layer.fontSize;
  // One undo step per change.
  const set = (next: TextAnim | null) => fields.setStatic(phase === 'in' ? { textIn: next } : { textOut: next });
  const style = anim ? (matchStyle(anim, phase)?.id ?? 'custom') : 'none';
  const pickStyle = (value: string) => {
    if (value === 'none') return set(null);
    const s = findStyle(value);
    // Switching styles keeps the user's delay (and shuffle).
    if (s) set(styleAnim(s, fontSize, anim ? { delay: anim.delay, seed: anim.seed } : {}));
  };
  const preview = () => {
    const w = phaseWindow(layer, phase);
    if (!w) return;
    const t0 = scene.start + layer.start;
    useEditor.getState().previewRange(t0 + w.start - 0.5, t0 + w.end + 0.5);
  };
  const options = [{ value: 'none', label: 'None' }, ...stylesFor(phase).map((s) => ({ value: s.id, label: s.label }))];
  if (style === 'custom') options.push({ value: 'custom', label: 'Custom' });

  return (
    <div className="textanim-phase" data-testid={id('phase')}>
      <div className="textanim-head">
        <h4 title={tips.heading}>{phase === 'in' ? 'Animate in' : 'Animate out'}</h4>
        {anim && (
          <button onClick={preview} title={tips.preview} data-testid={id('preview')}>
            ▶ Preview
          </button>
        )}
      </div>
      <Row label="Style" tip={tips.style}>
        <Select value={style} options={options} onChange={pickStyle} testId={id('style')} tip={tips.style} />
      </Row>
      {anim && <Customise phase={phase} anim={anim} fontSize={fontSize} set={set} />}
    </div>
  );
}

function Customise({ phase, anim, fontSize, set }: { phase: Phase; anim: TextAnim; fontSize: number; set: (a: TextAnim) => void }) {
  const tips = TIPS[phase];
  const id = (name: string) => `textanim-${phase}-${name}`;
  const typewriter = anim.effect === 'typewriter';
  const patch = (p: Partial<TextAnim>) => set({ ...anim, ...p });

  const setUnit = (unit: Unit) => patch({ unit, ...(anim.stagger === UNIT_GAP[anim.unit] ? gapPatch(anim, UNIT_GAP[unit]) : {}) });
  const setEffect = (effect: Effect) => {
    const next: Partial<TextAnim> = { effect };
    // Sensible starting values when "distance" changes meaning (move ↔ blur) or a typewriter turns into a motion.
    if (isMove(effect) && !isMove(anim.effect)) next.distance = Math.round(0.5 * fontSize);
    if (effect === 'blur' && anim.effect !== 'blur') next.distance = Math.round(0.15 * fontSize);
    if (effect === 'typewriter') next.duration = Math.max(0.01, anim.stagger);
    else if (typewriter) {
      next.duration = 0.5;
      next.easing = { type: phase === 'in' ? 'easeOut' : 'easeIn' };
    }
    patch(next);
  };

  return (
    <details className="customise" data-testid={id('customise')}>
      <summary title="Fine-tune how the pieces move, and when">Customise</summary>
      <div className="customise-body">
        <Row label="Animate by" tip={UNIT_TIP}>
          <Select value={anim.unit} options={UNITS} onChange={setUnit} testId={id('unit')} tip={UNIT_TIP} />
        </Row>
        <Row label="Effect" tip={tips.effect}>
          <Select value={anim.effect} options={EFFECTS} onChange={setEffect} testId={id('effect')} tip={tips.effect} />
        </Row>
        <Row label="Order" tip={ORDER_TIP}>
          <Select value={anim.order} options={ORDERS} onChange={(order) => patch({ order })} testId={id('order')} tip={ORDER_TIP} />
        </Row>
        <Row label={`Gap between ${UNIT_NOUN[anim.unit]}s (s)`} tip={`Seconds between one ${UNIT_NOUN[anim.unit]} starting and the next.`}>
          <NumberField value={anim.stagger} step={0.01} min={0} decimals={3} onCommit={(v) => patch(gapPatch(anim, v))} testId={id('stagger')} />
        </Row>
        {!typewriter && (
          <Row label="Each takes (s)" tip={tips.duration}>
            <NumberField value={anim.duration} step={0.05} min={0.01} decimals={3} onCommit={(duration) => patch({ duration })} testId={id('duration')} />
          </Row>
        )}
        <Row label={phase === 'in' ? 'Starts after (s)' : 'Ends before layer end (s)'} tip={tips.delay}>
          <NumberField value={anim.delay} step={0.1} min={0} decimals={3} onCommit={(delay) => patch({ delay })} testId={id('delay')} />
        </Row>
        {isMove(anim.effect) && (
          <Row label="Distance (px)" tip={tips.distance}>
            <NumberField value={anim.distance} step={1} onCommit={(distance) => patch({ distance })} testId={id('distance')} />
          </Row>
        )}
        {anim.effect === 'blur' && (
          <Row label="Blur amount (px)" tip={tips.blur}>
            <NumberField value={anim.distance} step={1} min={0} onCommit={(distance) => patch({ distance })} testId={id('distance')} />
          </Row>
        )}
        {!typewriter && (
          <div title="How each piece speeds up and slows down.">
            <EasingPicker value={anim.easing} onChange={(easing) => patch({ easing })} testId={id('easing')} />
          </div>
        )}
        {anim.order === 'random' && (
          <Row label="Shuffle" tip="Change this number for a different random order.">
            <NumberField value={anim.seed} step={1} decimals={0} onCommit={(v) => patch({ seed: Math.round(v) })} testId={id('seed')} />
          </Row>
        )}
        {typewriter && <CheckRow label="Caret" tip={tips.caret} checked={anim.caret} onChange={(caret) => patch({ caret })} testId={id('caret')} />}
      </div>
    </details>
  );
}

/** A typewriter's (hidden) length follows its gap, so a typewriter-out finishes right at the end of the layer. */
function gapPatch(anim: TextAnim, stagger: number): Partial<TextAnim> {
  return anim.effect === 'typewriter' ? { stagger, duration: Math.max(0.01, stagger) } : { stagger };
}
