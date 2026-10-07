// A2 text animators in Node: units, ranks, in/out timing (incl. the overlap rule), effects (incl. the layer-scale factor
// and chained blurs), the caret, the styles table, and the draw calls renderFrame makes (fully revealed text draws
// exactly the v1 calls; blurred units are clipped; inkBounds contains every animated unit). Pixel checks live in
// tests/e2e/engine-textanim.spec.ts.
import { describe, expect, it } from 'vitest';
import { applyEasing } from '../../src/shared/easing';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { inkBounds } from '../../src/shared/inkBounds';
import { drawLayer, renderFrame } from '../../src/shared/renderFrame';
import { ProjectSchema, TextAnimSchema, type Layer, type LayerInput, type Project, type TextAnim, type TextLayer } from '../../src/shared/schema';
import {
  animSpan,
  CARET,
  caretBlinkOn,
  caretShows,
  composeLooks,
  easingRange,
  findStyle,
  graphemes,
  matchStyle,
  outStart,
  phaseLook,
  phaseWindow,
  REST,
  splitUnits,
  styleAnim,
  stylesFor,
  TEXT_ANIM_STYLES,
  textAnimFrame,
  textAnimTiming,
  unitProgress,
  unitRanks,
} from '../../src/shared/textAnim';
import { allRecorders, drawnPoints, parseEntry, recordingCtx, unclippedFilteredDraws } from './helpers/recordingCtx';

const base = { visible: true, locked: false, start: 0, duration: 4, anchorX: 0.5, anchorY: 0.5, x: 800, y: 450, scale: 1, rotation: 0, opacity: 1, keyframes: {} };
const text = (over: Partial<LayerInput> = {}): TextLayer =>
  makeLayer({ ...base, id: 't', name: 'T', type: 'text', content: 'Ship faster today', fontFamily: 'Inter', fontSize: 60, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center', color: '#ffffff', ...over } as LayerInput) as TextLayer;
const A = (over: Partial<TextAnim> = {}): TextAnim => ({ unit: 'word', effect: 'fade', order: 'forward', stagger: 0.1, duration: 0.5, delay: 0, distance: 40, easing: { type: 'linear' }, seed: 1, caret: false, ...over });

function project(layers: Layer[]): Project {
  return makeProject({
    schemaVersion: 2,
    settings: { durationSec: 4, aspect: '16:9', width: 1600, height: 900, fps: 30, background: '#101828' },
    assets: [],
    scenes: [{ id: 's', name: 'S', start: 0, duration: 4, layers }],
  });
}

/** Render layers with a recording pool at time t; returns the main recorder. */
function render(layers: Layer[], t: number, scale = 1) {
  const rec = recordingCtx(1600 * scale, 900 * scale);
  renderFrame(project(layers), t, rec.ctx, scale, { images: new Map(), canvasPool: rec.pool });
  return rec;
}

const fillTexts = (log: string[]) => log.filter((l) => l.startsWith('fillText(')).map((l) => (parseEntry(l) as { args: unknown[] }).args[0] as string);
const frame = (layer: TextLayer, t: number) => textAnimFrame(recordingCtx().ctx, layer, t);

describe('units', () => {
  it('letters are graphemes (emoji, flags and accents stay whole), spaces included', () => {
    expect(graphemes('a👍🏽é🇬🇧 b')).toEqual(['a', '👍🏽', 'é', '🇬🇧', ' ', 'b']);
    // Without Intl.Segmenter: code points (a skin-tone emoji splits, but surrogate pairs never do).
    expect(graphemes('a👍🏽b', null)).toEqual(['a', '👍', '🏽', 'b']);
    const u = splitUnits('Hi 👋\nyo', 'char');
    expect(u.map((x) => [x.line, x.start, x.text])).toEqual([[0, 0, 'H'], [0, 1, 'i'], [0, 2, ' '], [0, 3, '👋'], [1, 0, 'y'], [1, 1, 'o']]);
    expect(u[3].end).toBe(5); // a surrogate pair is two UTF-16 code units
  });

  it('words are whitespace-separated; trailing spaces stay with the word, leading spaces belong to no word', () => {
    expect(splitUnits('Ship  faster today ', 'word').map((x) => x.text)).toEqual(['Ship  ', 'faster ', 'today ']);
    expect(splitUnits('  Hi there\n\nAgain', 'word').map((x) => [x.line, x.start, x.text])).toEqual([[0, 2, 'Hi '], [0, 5, 'there'], [2, 0, 'Again']]);
  });

  it('lines are whole lines; blank lines are not units', () => {
    expect(splitUnits('One\n\n  \nTwo ', 'line').map((x) => [x.line, x.text])).toEqual([[0, 'One'], [3, 'Two ']]);
  });
});

describe('ranks', () => {
  it('forward, reverse, middle out (ties: left first), edges in (= reverse of middle out)', () => {
    expect(unitRanks(5, 'forward', 1)).toEqual([0, 1, 2, 3, 4]);
    expect(unitRanks(5, 'reverse', 1)).toEqual([4, 3, 2, 1, 0]);
    expect(unitRanks(5, 'center', 1)).toEqual([3, 1, 0, 2, 4]);
    expect(unitRanks(4, 'center', 1)).toEqual([2, 0, 1, 3]);
    expect(unitRanks(5, 'edges', 1)).toEqual([1, 3, 4, 2, 0]);
    expect(unitRanks(4, 'edges', 1)).toEqual([1, 3, 2, 0]);
    expect(unitRanks(0, 'center', 1)).toEqual([]);
  });

  it('random is a seeded permutation: the same seed gives the same order, another seed another one', () => {
    const a = unitRanks(12, 'random', 7);
    expect([...a].sort((x, y) => x - y)).toEqual([...Array(12).keys()]);
    expect(unitRanks(12, 'random', 7)).toEqual(a);
    expect(unitRanks(12, 'random', 8)).not.toEqual(a);
    expect(a).not.toEqual([...Array(12).keys()]);
  });
});

describe('timing', () => {
  it('in: rank r starts at delay + r·stagger; u = clamp((local − start)/duration); visibility e = ease(u)', () => {
    const a = A({ delay: 0.2, stagger: 0.1, duration: 0.5 });
    expect(unitProgress(a, 'in', 2, 4, 0.4, 4)).toBe(0);
    expect(unitProgress(a, 'in', 2, 4, 0.45, 4)).toBeCloseTo(0.1, 10);
    expect(unitProgress(a, 'in', 2, 4, 2, 4)).toBe(1);
    expect(phaseLook(a, 'in', 0.1).alpha).toBeCloseTo(0.1, 10);
    const eased = A({ easing: { type: 'easeOut' } });
    expect(phaseLook(eased, 'in', 0.3).alpha).toBeCloseTo(applyEasing({ type: 'easeOut' }, 0.3, 0.5), 10);
  });

  it('out: span = (n−1)·stagger + duration, outStart = layer.duration − delay − span; the last unit is gone `delay` s before the end', () => {
    const a = A({ delay: 0.2, stagger: 0.1, duration: 0.5 });
    expect(animSpan(a, 4)).toBeCloseTo(0.8, 10);
    expect(outStart(a, 4, 3)).toBeCloseTo(2, 10);
    expect(unitProgress(a, 'out', 0, 4, 1.99, 3)).toBe(0);
    expect(unitProgress(a, 'out', 0, 4, 2, 3)).toBeCloseTo(0, 10);
    expect(unitProgress(a, 'out', 0, 4, 2.25, 3)).toBeCloseTo(0.5, 10);
    expect(unitProgress(a, 'out', 3, 4, 2.79, 3)).toBeLessThan(1);
    expect(unitProgress(a, 'out', 3, 4, 2.8, 3)).toBeCloseTo(1, 10);
  });

  it('out uses the easing as picked (not mirrored): visibility 1 − ease(v)', () => {
    const a = A({ easing: { type: 'easeIn' } });
    expect(phaseLook(a, 'out', 0.5).alpha).toBeCloseTo(1 - applyEasing({ type: 'easeIn' }, 0.5, 0.5), 10);
    expect(phaseLook(a, 'out', 0.5).alpha).toBeGreaterThan(0.6); // easeIn leaves slowly at first
  });

  it('order describes the exit sequence too: forward = first unit leaves first, reverse = last unit first', () => {
    const t = 4 - animSpan(A(), 3) + 0.2; // inside the out phase of a 3-word text (layer 4 s)
    const alphas = (order: TextAnim['order']) => frame(text({ textOut: A({ order }) }), t).units!.map((u) => u.look.alpha);
    const fwd = alphas('forward');
    expect(fwd[0]).toBeLessThan(fwd[1]);
    expect(fwd[1]).toBeLessThan(fwd[2]);
    const rev = alphas('reverse');
    expect(rev[2]).toBeLessThan(rev[1]);
    expect(rev[1]).toBeLessThan(rev[0]);
  });

  it('a short layer where in and out overlap: visibility = e_in · (1 − e_out), outStart clamped ≥ 0', () => {
    const l = text({ content: 'One two', duration: 0.6, textIn: A({ stagger: 0.2, duration: 0.5 }), textOut: A({ stagger: 0.2, duration: 0.5 }) });
    expect(outStart(l.textOut!, 2, 0.6)).toBe(0); // 0.6 − 0 − 0.7 < 0
    const t = 0.3;
    const u0 = frame(l, t).units!.find((u) => u.text.startsWith('One'))!;
    const eIn = unitProgress(l.textIn!, 'in', 0, 2, t, 0.6);
    const eOut = unitProgress(l.textOut!, 'out', 0, 2, t, 0.6);
    expect(u0.look.alpha).toBeCloseTo(eIn * (1 - eOut), 10);
    expect(textAnimTiming(l, t)).toMatchObject({ inActive: true, outActive: true });
  });

  it('phase windows for ▶ Preview', () => {
    const l = text({ duration: 3, textIn: A({ delay: 0.2 }), textOut: A({ delay: 0.5 }) });
    expect(phaseWindow(l, 'in')).toEqual({ start: 0, end: 0.2 + animSpan(l.textIn!, 3) });
    expect(phaseWindow(l, 'out')).toEqual({ start: 3 - 0.5 - animSpan(l.textOut!, 3), end: 3 });
    expect(phaseWindow(text(), 'in')).toBeNull();
  });
});

describe('effects', () => {
  it('rise / drop / scale / blur / fade in move from their offset to rest; e = 1 is exactly the rest look', () => {
    expect(phaseLook(A({ effect: 'rise' }), 'in', 0.25)).toEqual({ alpha: 0.25, dy: 30, scale: 1, blur: 0 });
    expect(phaseLook(A({ effect: 'drop' }), 'in', 0.25)).toEqual({ alpha: 0.25, dy: -30, scale: 1, blur: 0 });
    expect(phaseLook(A({ effect: 'scale' }), 'in', 0.25)).toEqual({ alpha: 0.25, dy: 0, scale: 0.25, blur: 0 });
    expect(phaseLook(A({ effect: 'blur' }), 'in', 0.25)).toEqual({ alpha: 0.25, dy: 0, scale: 1, blur: 30 });
    for (const effect of ['fade', 'rise', 'drop', 'scale', 'blur'] as const) {
      expect(phaseLook(A({ effect }), 'in', 1)).toEqual(REST);
      expect(phaseLook(A({ effect }), 'out', 0)).toEqual(REST);
    }
  });

  it('out keeps moving in the direction of travel: rise further up, drop further down, scale 1 → 0, blur 0 → distance', () => {
    expect(phaseLook(A({ effect: 'rise' }), 'out', 0.25)).toEqual({ alpha: 0.75, dy: -10, scale: 1, blur: 0 });
    expect(phaseLook(A({ effect: 'drop' }), 'out', 0.25)).toEqual({ alpha: 0.75, dy: 10, scale: 1, blur: 0 });
    expect(phaseLook(A({ effect: 'scale' }), 'out', 0.25).scale).toBe(0.75);
    expect(phaseLook(A({ effect: 'blur' }), 'out', 0.25).blur).toBe(10);
    expect(phaseLook(A({ effect: 'blur' }), 'out', 1)).toEqual({ alpha: 0, dy: 0, scale: 1, blur: 40 });
  });

  it('rise-out: the drawn y of every word decreases over time (it moves up while it fades)', () => {
    const l = text({ content: 'Up we go', textOut: A({ effect: 'rise', stagger: 0.05, duration: 0.6, distance: 50 }) });
    const start = outStart(l.textOut!, 3, 4);
    const ys = [0.1, 0.25, 0.4, 0.55].map((dt) => {
      const pts = drawnPoints(render([l], start + dt).log).filter((p) => p.op === 'fillText');
      return Math.min(...pts.map((p) => p.y));
    });
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1]);
    // And the look itself: dy = −e·distance, more negative as v grows.
    const dys = [0.1, 0.4, 0.7, 1].map((v) => phaseLook(l.textOut!, 'out', v).dy);
    for (let i = 1; i < dys.length; i++) expect(dys[i]).toBeLessThan(dys[i - 1]);
  });

  it('typewriter: no easing; a unit shows once u > 0 (in) and hides once v > 0 (out)', () => {
    const a = A({ effect: 'typewriter', easing: { type: 'easeIn' } });
    expect([0, 1e-9, 0.5, 1].map((p) => phaseLook(a, 'in', p).alpha)).toEqual([0, 1, 1, 1]);
    expect([0, 1e-9, 0.5, 1].map((p) => phaseLook(a, 'out', p).alpha)).toEqual([1, 0, 0, 0]);
    // A typewriter reveal draws whole, unmoved letters: only the typed ones.
    const l = text({ content: 'Typing', align: 'left', textIn: A({ unit: 'char', effect: 'typewriter', stagger: 0.1, duration: 0.1 }) });
    expect(fillTexts(render([l], 0.25).log)).toEqual(['T', 'y', 'p']);
  });

  it('overshooting easings: alpha is clamped, the unit may bounce past rest, the scale and blur never go negative', () => {
    const spring = { type: 'spring', stiffness: 300, damping: 4, mass: 1 } as const;
    const p = [...Array(100)].map((_, i) => i / 100).find((x) => applyEasing(spring, x, 0.5) > 1.2)!;
    expect(p).toBeDefined();
    const rise = phaseLook(A({ effect: 'rise', easing: spring }), 'in', p);
    expect(rise.alpha).toBe(1);
    expect(rise.dy).toBeLessThan(0); // bounced above its resting place
    const curve = { type: 'cubicBezier', x1: 0.3, y1: -1, x2: 0.7, y2: 2 } as const;
    expect(phaseLook(A({ effect: 'scale', easing: curve }), 'in', 0.1).scale).toBe(0);
    expect(phaseLook(A({ effect: 'blur', easing: curve }), 'in', 0.8).blur).toBe(0);
    expect(easingRange(curve)).toEqual([-1, 2]);
    expect(easingRange({ type: 'easeOut' })).toEqual([0, 1]);
    const [lo, hi] = easingRange(spring);
    expect(lo).toBe(0);
    for (let i = 0; i <= 400; i++) expect(applyEasing(spring, i / 400, 3)).toBeLessThanOrEqual(hi + 1e-12);
  });

  it('composition: a phase scales about its own unit centre, then the next one; opacities multiply; blurs chain', () => {
    const c = composeLooks([
      { look: { alpha: 0.5, dy: 10, scale: 0.5, blur: 4 }, cx: 100, cy: 20 },
      { look: { alpha: 0.4, dy: -6, scale: 2, blur: 3 }, cx: 40, cy: 20 },
    ]);
    // p → 2·(0.5·(p − (100, 20)) + (100, 20) + (0, 10) − (40, 20)) + (40, 20) + (0, −6)
    const map = (x: number, y: number) => [c.s * x + c.tx, c.s * y + c.ty];
    expect(map(100, 20)).toEqual([160, 34]);
    expect(map(0, 0)).toEqual([60, 14]);
    expect(c.alpha).toBeCloseTo(0.2, 10);
    expect(c.blurs).toEqual([4, 3]);
    expect(composeLooks([{ look: REST, cx: 5, cy: 5 }])).toEqual({ alpha: 1, s: 1, tx: 0, ty: 0, blurs: [] });
  });
});

describe('drawing', () => {
  const words = (effect: TextAnim['effect'], over: Partial<TextAnim> = {}) => A({ effect, stagger: 0.1, duration: 0.6, distance: 20, easing: { type: 'easeOut' }, ...over });

  it('fully revealed text draws exactly the v1 calls (whole lines), also with effects and several lines', () => {
    const anims = { textIn: words('rise'), textOut: words('blur', { delay: 0.2 }) };
    const variants: Partial<LayerInput>[] = [{}, { content: 'Two\nlines here' }, { shadow: true, shadowColor: '#000000aa', shadowBlur: 6, shadowOffsetY: 4 }, { blur: 2, blendMode: 'screen' }];
    for (const v of variants) {
      for (const t of [1.2, 2.5]) {
        const plain = render([text(v)], t, 0.5);
        const animated = render([text({ ...v, ...anims })], t, 0.5);
        expect(animated.log, JSON.stringify(v)).toEqual(plain.log);
        expect(animated.children.map((c) => c.log)).toEqual(plain.children.map((c) => c.log));
      }
    }
    // ... and the units really are drawn one by one while the animation runs.
    expect(fillTexts(render([text(anims)], 0.3).log)).toEqual(['Ship ', 'faster ', 'today']);
    expect(fillTexts(render([text(anims)], 3.4).log)).toEqual(['Ship ', 'faster ', 'today']);
    expect(fillTexts(render([text(anims)], 3.9).log)).toEqual([]); // all gone 0.2 s before the end
    expect(fillTexts(render([text(anims)], 2).log)).toEqual(['Ship faster today']);
  });

  it('every blurred unit is clipped to the area its blur reaches; layer effects isolate the running animation', () => {
    const l = text({ content: 'Blur in\nwords now', textIn: words('blur', { distance: 12 }) });
    const rec = render([l], 0.3);
    const filters = rec.log.filter((x) => x.startsWith('filter='));
    expect(filters.length).toBeGreaterThan(1);
    expect(unclippedFilteredDraws(rec.log)).toEqual([]);
    expect(rec.children).toHaveLength(0); // no layer effect: drawn straight onto the frame
    const fx = render([text({ content: 'Blur in\nwords now', blur: 2, shadow: true, shadowOffsetY: 6, textIn: words('blur', { distance: 12 }) })], 0.3);
    expect(fx.children).toHaveLength(1); // isolated: units drawn plainly, the layer effect applied once at the composite
    for (const r of allRecorders(fx)) expect(unclippedFilteredDraws(r.log)).toEqual([]);
    expect(fx.children[0].log.some((x) => x.startsWith('shadow'))).toBe(false);
    expect(fx.log).toContain('filter="blur(2px)"');
    // A one-line text with an effect is a single draw at rest, so it keeps the direct path then.
    expect(render([text({ shadow: true, shadowOffsetY: 6, textIn: words('fade') })], 2).children).toHaveLength(0);
    expect(render([text({ shadow: true, shadowOffsetY: 6, textIn: words('fade') })], 0.2).children).toHaveLength(1);
  });

  it('the unit blur is (1 − e)·distance·k with k = render scale × |layer scale|', () => {
    const blurOf = (layerScale: number, scale: number) => {
      const l = text({ scale: layerScale, textIn: A({ effect: 'blur', unit: 'line', duration: 1, distance: 10 }) });
      return render([l], 0.25, scale).log.filter((x) => x.startsWith('filter=')).map((x) => parseEntry(x) as { value: string })[0].value;
    };
    // u = 0.25, linear: blur = 0.75 × 10 = 7.5 layer px.
    expect(blurOf(1, 1)).toBe('blur(7.5px)');
    expect(blurOf(2, 0.5)).toBe('blur(7.5px)');
    expect(blurOf(-3, 1)).toBe('blur(22.5px)');
    expect(blurOf(1, 0.5)).toBe('blur(3.75px)');
  });

  it('the Grow effect scales each unit about its centre inside the layer transform (so it composes with the layer scale)', () => {
    const l = text({ content: 'Grow', scale: 2, textIn: A({ effect: 'scale', unit: 'line', duration: 1 }) });
    const at = (t: number) => {
      const pts = drawnPoints(render([l], t).log).filter((p) => p.op === 'fillText');
      return Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    };
    // Fake metrics: 'Grow' is 40 units wide; layer scale 2 → 80 px at rest, × u (linear) while growing.
    expect(at(2)).toBeCloseTo(80, 6);
    expect(at(0.5)).toBeCloseTo(40, 6);
    expect(at(0.25)).toBeCloseTo(20, 6);
  });

  it('chained blur filters when the in and out phases both blur the same unit', () => {
    const l = text({ content: 'Hi', duration: 0.8, textIn: A({ effect: 'blur', unit: 'line', duration: 0.6, distance: 10 }), textOut: A({ effect: 'blur', unit: 'line', duration: 0.6, distance: 8 }) });
    // t = 0.3: u = 0.5 → in blur 5; out starts at 0.2, v = 1/6 → out blur 8/6.
    const f = (parseEntry(render([l], 0.3).log.find((x) => x.startsWith('filter='))!) as { value: string }).value;
    const [, a, b] = /^blur\(([\d.]+)px\) blur\(([\d.]+)px\)$/.exec(f)!;
    expect(Number(a)).toBeCloseTo(5, 10);
    expect(Number(b)).toBeCloseTo(8 / 6, 10);
    expect(unclippedFilteredDraws(render([l], 0.3).log)).toEqual([]);
  });

  it('mixed units in an overlap: the finer unit is drawn and a word grows as a whole (about the word centre)', () => {
    const l = text({ content: 'Big word', align: 'left', x: 0, y: 0, anchorX: 0, anchorY: 0, duration: 0.6,
      textIn: A({ unit: 'char', effect: 'fade', stagger: 0, duration: 0.4 }), textOut: A({ unit: 'word', effect: 'scale', stagger: 0, duration: 0.4 }) });
    const f = frame(l, 0.3); // in: u = 0.75; out starts at 0.2: v = 0.25 → each word at scale 0.75
    expect(f.units!.map((u) => u.text)).toEqual(['B', 'i', 'g', ' ', 'w', 'o', 'r', 'd']);
    const g = f.units![1];
    expect(g.look.alpha).toBeCloseTo(0.75 * 0.75, 10);
    // 'Big ' spans x 0..40 of ink (fake metrics: 10 per char, spaces too): its centre (20) stays put while it shrinks.
    expect(g.look.s).toBeCloseTo(0.75, 10);
    expect(g.look.s * 20 + g.look.tx).toBeCloseTo(20, 10);
    const w = f.units![5]; // 'o' of 'word' (ink 40..80, centre 60)
    expect(w.look.s * 60 + w.look.tx).toBeCloseTo(60, 10);
  });

  it('is deterministic (also with a random order)', () => {
    const l = text({ content: 'One two three four', textIn: words('rise', { order: 'random', seed: 42 }) });
    const a = render([l], 0.33).log;
    render([l], 1.7);
    expect(render([l], 0.33).log).toEqual(a);
  });
});

describe('caret', () => {
  const typewriter = (over: Partial<TextAnim> = {}) => A({ unit: 'char', effect: 'typewriter', stagger: 0.1, duration: 0.1, caret: true, ...over });
  const caretRect = (l: TextLayer, t: number) => {
    const r = render([l], t).log.find((x) => x.startsWith('fillRect(') && !x.startsWith('fillRect([0,0,1600'));
    return r ? ((parseEntry(r) as { args: number[] }).args) : null;
  };

  it('blinks with a 1 s period from layer-local time', () => {
    expect([0, 0.2, 0.49, 0.5, 0.9, 1, 1.3, 1.7].map(caretBlinkOn)).toEqual([true, true, true, false, false, true, true, false]);
  });

  it('like a real text cursor: solid while typing, blinking before and after (from the last keystroke)', () => {
    // Typing from 0.7 s to 1.1 s: blinking from the layer's start before, solid while typing (0.9 s would blink off),
    // then blinking again from the last keystroke (on until 1.6 s, off until 2.1 s).
    expect([0, 0.6, 0.7, 0.9, 1.1, 1.5, 1.65, 2.1].map((t) => caretShows(t, 0.7, 1.1))).toEqual([true, false, true, true, true, true, false, true]);
  });

  it('sits after the last visible character, at the start before anything is typed, and hides 1 s after the text is complete', () => {
    const l = text({ content: 'Hello', align: 'left', x: 0, y: 0, anchorX: 0, anchorY: 0, textIn: typewriter({ delay: 0.2 }) });
    // Fake metrics: 10 px per character. Layer box at the origin, line middle at y = 36. Typing: 0.2–0.6 s.
    const fs = 60;
    caretRect(l, 0.1)!.forEach((v, i) => expect(v).toBeCloseTo([CARET.gap * fs, 36 - fs / 2, CARET.width * fs, fs][i], 10)); // before typing
    expect(caretRect(l, 0.35)![0]).toBeCloseTo(20 + CARET.gap * fs, 10); // 'He' typed
    expect(caretRect(l, 0.55)![0]).toBeCloseTo(40 + CARET.gap * fs, 10); // still typing: solid (it used to blink off here)
    expect(caretRect(l, 0.7)![0]).toBeCloseTo(50 + CARET.gap * fs, 10); // complete at 0.6 s: on for 0.5 s…
    expect(caretRect(l, 1.2)).toBeNull(); // …then blinks off
    expect(caretRect(l, 1.4)).toBeNull();
    expect(caretRect(l, 1.55)).toBeNull(); // window over at 1.6 s
    expect(textAnimTiming(l, 2.1).caret).toBe(false);
    // No caret without the option, or for other effects.
    expect(caretRect(text({ ...l, textIn: typewriter({ caret: false }) }), 0.35)).toBeNull();
    expect(caretRect(text({ ...l, textIn: A({ caret: true }) }), 0.35)).toBeNull();
  });

  it('backspace with a caret: shows 1 s before the deletion starts and stays after the last remaining letter', () => {
    const l = text({ content: 'Bye', align: 'left', x: 0, y: 0, anchorX: 0, anchorY: 0, duration: 3.4, textOut: typewriter({ order: 'reverse' }) });
    const s = outStart(l.textOut!, 3, 3.4); // 3.4 − 0.3: 'e' goes at 3.1, 'y' at 3.2, 'B' at 3.3
    expect(s).toBeCloseTo(3.1, 10);
    expect(caretRect(l, 2)).toBeNull(); // blinked on, but before its window (3.1 − 1 s)
    expect(caretRect(l, 2.3)![0]).toBeCloseTo(30 + CARET.gap * 60, 10);
    expect(fillTexts(render([l], 3.15).log)).toEqual(['B', 'y']);
    expect(caretRect(l, 3.15)![0]).toBeCloseTo(20 + CARET.gap * 60, 10);
    expect(fillTexts(render([l], 3.35).log)).toEqual([]);
    expect(caretRect(l, 3.35)![0]).toBeCloseTo(CARET.gap * 60, 10); // everything deleted: back at the start
  });
});

describe('inkBounds contains every animated unit', () => {
  const spring = { type: 'spring', stiffness: 260, damping: 5, mass: 1 } as const;
  const wild = { type: 'cubicBezier', x1: 0.2, y1: -1.2, x2: 0.6, y2: 2.4 } as const;
  const cases: [string, Partial<LayerInput>][] = [
    ['words rise (spring overshoot), rotated', { rotation: 25, textIn: A({ effect: 'rise', distance: 60, easing: spring }) }],
    ['letters drop, custom curve far outside 0..1', { content: 'Drop it\nlow', textIn: A({ unit: 'char', effect: 'drop', stagger: 0.03, distance: 45, easing: wild }) }],
    ['lines grow with a springy overshoot, mirrored', { content: 'Grow\nlines wide', scale: -1.4, textIn: A({ unit: 'line', effect: 'scale', duration: 0.8, easing: spring }) }],
    ['words blur in and rise out', { textIn: A({ effect: 'blur', distance: 14 }), textOut: A({ effect: 'rise', distance: 30, delay: 0.3 }) }],
    ['short layer: letters grow in, words blur out (overlap)', { duration: 0.9, content: 'Tiny bits', textIn: A({ unit: 'char', effect: 'scale', stagger: 0.05, easing: spring }), textOut: A({ effect: 'blur', distance: 9, easing: wild }) }],
    ['typewriter with a caret, right-aligned, two lines', { align: 'right', content: 'Type\nthis line', textIn: A({ unit: 'char', effect: 'typewriter', stagger: 0.08, caret: true }) }],
    ['backspace with a caret', { textOut: A({ unit: 'char', effect: 'typewriter', order: 'reverse', stagger: 0.05, caret: true }) }],
    ['middle-out words, layer blur + shadow (isolated)', { blur: 3, shadow: true, shadowOffsetY: 10, shadowBlur: 8, textIn: A({ effect: 'rise', order: 'center', distance: 35, easing: spring }) }],
  ];
  for (const [name, over] of cases) {
    it(name, () => {
      const layer = text(over);
      let drawn = 0;
      for (const scale of [1, 0.37, 2])
        for (const local of [0, 0.05, 0.2, 0.33, 0.5, 0.7, 1.1, 1.6, 2.5, 3.2, 3.5, 3.75, 3.9, 3.99]) {
          if (local >= layer.duration) continue;
          const rec = recordingCtx(4000, 3000);
          const ink = inkBounds(layer, local, scale, rec.ctx);
          rec.reset();
          rec.ctx.setTransform(scale, 0, 0, scale, 0, 0);
          drawLayer(rec.ctx, layer, local, { images: new Map(), createCanvas: rec.createCanvas }, scale);
          // Isolated layers draw into a scratch canvas: replay its log at its offset on the frame.
          const logs = [rec.log, ...rec.children.map((c) => c.log)];
          const pts = logs.flatMap((log, i) => {
            if (i === 0) return drawnPoints(log).filter((p) => p.op !== 'drawImage');
            const draw = rec.log.find((l) => l.startsWith(`drawImage(["<canvas main.${i - 1}>"`))!;
            const [, ox, oy] = (parseEntry(draw) as { args: number[] }).args;
            return drawnPoints(log).map((p) => ({ ...p, x: p.x + ox, y: p.y + oy }));
          });
          const outside = pts.filter((p) => p.x < ink.x0 - 1e-6 || p.x > ink.x1 + 1e-6 || p.y < ink.y0 - 1e-6 || p.y > ink.y1 + 1e-6);
          expect(outside, `${name} at t=${local}, scale ${scale}`).toEqual([]);
          drawn += pts.length;
        }
      expect(drawn).toBeGreaterThan(100);
    });
  }
});

describe('styles', () => {
  it('the table: in Words rise (suggested), Letters fade, Typewriter, Lines slide up, Blur in; out Words fade out (suggested), Backspace', () => {
    expect(stylesFor('in').map((s) => s.label)).toEqual(['Words rise', 'Letters fade', 'Typewriter', 'Lines slide up', 'Blur in']);
    expect(stylesFor('out').map((s) => s.label)).toEqual(['Words fade out', 'Backspace']);
    const pick = (id: string) => findStyle(id)!.anim;
    expect(pick('words-rise')).toMatchObject({ unit: 'word', effect: 'rise', order: 'forward', stagger: 0.08, duration: 0.5, distance: 0.5, easing: { type: 'easeOut' } });
    expect(pick('letters-fade')).toMatchObject({ unit: 'char', effect: 'fade', stagger: 0.03, duration: 0.4, easing: { type: 'easeOut' } });
    expect(pick('typewriter')).toMatchObject({ unit: 'char', effect: 'typewriter', stagger: 0.05, caret: true });
    expect(pick('lines-slide-up')).toMatchObject({ unit: 'line', effect: 'rise', stagger: 0.15, duration: 0.6, distance: 0.6, easing: { type: 'easeOut' } });
    expect(pick('blur-in')).toMatchObject({ unit: 'word', effect: 'blur', stagger: 0.06, duration: 0.6, distance: 0.15, easing: { type: 'easeOut' } });
    expect(pick('words-fade-out')).toMatchObject({ unit: 'word', effect: 'fade', stagger: 0.04, duration: 0.3, easing: { type: 'easeIn' } });
    expect(pick('backspace')).toMatchObject({ unit: 'char', effect: 'typewriter', order: 'reverse', stagger: 0.03 });
  });

  it('distances are relative to the font size (whole pixels); styles round-trip through the schema and are recognised again', () => {
    expect(styleAnim(findStyle('words-rise')!, 173).distance).toBe(87);
    expect(styleAnim(findStyle('blur-in')!, 120).distance).toBe(18);
    expect(styleAnim(findStyle('lines-slide-up')!, 100, { delay: 0.4, seed: 9 })).toMatchObject({ distance: 60, delay: 0.4, seed: 9 });
    for (const style of TEXT_ANIM_STYLES) {
      const a = styleAnim(style, 96);
      expect(TextAnimSchema.parse(a)).toEqual(a);
      const layer = text({ [style.phase === 'in' ? 'textIn' : 'textOut']: a });
      const p = ProjectSchema.parse(JSON.parse(JSON.stringify(project([layer]))));
      const back = p.scenes[0].layers[0] as TextLayer;
      expect(style.phase === 'in' ? back.textIn : back.textOut).toEqual(a);
      expect(matchStyle(a, style.phase)?.id).toBe(style.id);
      // Delay, distance and seed don't make it "custom"; other changes do.
      expect(matchStyle({ ...a, delay: 1, distance: 3, seed: 5 }, style.phase)?.id).toBe(style.id);
      expect(matchStyle({ ...a, stagger: a.stagger + 0.01 }, style.phase)).toBeNull();
      expect(matchStyle(a, style.phase === 'in' ? 'out' : 'in')).toBeNull();
    }
    // Typewriters ignore the (hidden) length and easing, but not the caret.
    const tw = styleAnim(findStyle('typewriter')!, 50);
    expect(matchStyle({ ...tw, duration: 2, easing: { type: 'easeIn' } }, 'in')?.id).toBe('typewriter');
    expect(matchStyle({ ...tw, caret: false }, 'in')).toBeNull();
  });
});
