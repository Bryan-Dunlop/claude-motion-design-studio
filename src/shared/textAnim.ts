// Text animators (docs/v2-plan.md A2): split a text layer into letters / words / lines, rank the units, time the in and
// out phases, and turn their progress into each unit's opacity, offset, scale and blur. Pure: no clocks, no unseeded
// randomness; measuring needs a 2D context but leaves its state unchanged. Used by drawText, inkBounds and the
// Properties panel (styles table).
import { applyEasing } from './easing';
import { EMPTY_BOX, fontString, lineIsMixed, lineIsRtl, lineX, measureText, setLetterSpacing, type Box, type Ctx2D } from './geometry';
import { seededRandom } from './presets';
import type { Easing, TextAnim, TextLayer } from './schema';

export type UnitKind = TextAnim['unit'];
export type Phase = 'in' | 'out';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------- units

/** One unit in reading order: `text` is [start, end) of line `line` (lines = content split on '\n'). */
export interface UnitSpan {
  line: number;
  start: number;
  end: number;
  text: string;
}

const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** User-perceived characters: emoji, flags and accented letters stay whole (code points where Intl.Segmenter is missing). */
export function graphemes(s: string, segmenter: Pick<Intl.Segmenter, 'segment'> | null = graphemeSegmenter): string[] {
  return segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s);
}

/**
 * Units of one line: letters (every grapheme, spaces included, so a typewriter types the spaces too), words
 * (whitespace-separated, trailing spaces stay with the word) or the whole line. Blank lines have no word/line units.
 */
export function lineUnits(line: string, kind: UnitKind): { start: number; text: string }[] {
  // Mixed directions, or digits among right-to-left letters (numbers read left to right inside them), are reordered
  // by the browser: such a line animates as one unit.
  const whole = kind === 'line' || lineIsMixed(line) || (kind === 'char' && lineIsRtl(line) && /\p{Nd}/u.test(line));
  if (whole) return line.trim() ? [{ start: 0, text: line }] : [];
  if (kind === 'word') return Array.from(line.matchAll(/\S+\s*/g), (m) => ({ start: m.index ?? 0, text: m[0] }));
  const out: { start: number; text: string }[] = [];
  let i = 0;
  for (const g of graphemes(line)) {
    out.push({ start: i, text: g });
    i += g.length;
  }
  return out;
}

export function splitUnits(content: string, kind: UnitKind): UnitSpan[] {
  return content.split('\n').flatMap((line, li) => lineUnits(line, kind).map((u) => ({ line: li, start: u.start, end: u.start + u.text.length, text: u.text })));
}

const FINENESS: Record<UnitKind, number> = { char: 0, word: 1, line: 2 };
const finer = (a: UnitKind, b: UnitKind) => (FINENESS[a] <= FINENESS[b] ? a : b);

// ---------------------------------------------------------------- ranks & timing

/**
 * Rank of each unit (0 = goes first), for the in and the out phase alike. forward i; reverse n−1−i; center by
 * |i − (n−1)/2| (ties: left first); edges = reverse of center; random = seeded permutation (mulberry32).
 */
export function unitRanks(n: number, order: TextAnim['order'], seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  if (order === 'forward') return idx;
  if (order === 'reverse') return idx.map((i) => n - 1 - i);
  const rank = new Array<number>(n);
  if (order === 'random') {
    const rnd = seededRandom(seed);
    const perm = [...idx];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    perm.forEach((unit, r) => (rank[unit] = r));
    return rank;
  }
  const mid = (n - 1) / 2;
  const byDistance = [...idx].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
  byDistance.forEach((unit, r) => (rank[unit] = order === 'center' ? r : n - 1 - r));
  return rank;
}

/** Seconds from the first unit starting to the last one finishing: (n − 1)·stagger + duration. */
export function animSpan(a: TextAnim, n: number): number {
  return Math.max(0, n - 1) * a.stagger + a.duration;
}

/** Layer-local time the out phase starts: its last unit finishes `delay` s before the layer ends (never before 0). */
export function outStart(a: TextAnim, n: number, layerDuration: number): number {
  return Math.max(0, layerDuration - a.delay - animSpan(a, n));
}

/** Raw progress 0..1 of the unit with rank `rank`: u (in, from delay + rank·stagger) or v (out, from outStart + rank·stagger). */
export function unitProgress(a: TextAnim, phase: Phase, rank: number, n: number, local: number, layerDuration: number): number {
  const t0 = (phase === 'in' ? a.delay : outStart(a, n, layerDuration)) + rank * a.stagger;
  return clamp01((local - t0) / a.duration);
}

/** Layer-local [start, end] of a phase (for "▶ Preview"). */
export function phaseWindow(layer: TextLayer, phase: Phase): { start: number; end: number } | null {
  const a = phase === 'in' ? layer.textIn : layer.textOut;
  if (!a) return null;
  const n = splitUnits(layer.content, a.unit).length;
  if (phase === 'in') return { start: 0, end: Math.min(layer.duration, a.delay + animSpan(a, n)) };
  return { start: outStart(a, n, layer.duration), end: layer.duration };
}

// ---------------------------------------------------------------- effects

/** What one phase does to a unit. `dy` and `blur` are in layer pixels (the blur is multiplied by k when drawn). */
export interface PhaseLook {
  alpha: number;
  dy: number;
  scale: number;
  blur: number;
}

export const REST: PhaseLook = { alpha: 1, dy: 0, scale: 1, blur: 0 };

/**
 * Look of a unit at raw progress p (u in / v out). In: e = ease(u), visibility e. Out: e = ease(v) with the easing as
 * picked (not mirrored), visibility 1 − e, and the motion keeps going the same way: rise-out moves further up, drop-out
 * further down, scale-out shrinks 1 → 0, blur-out blurs 0 → distance. Typewriter: no easing, a unit shows once u > 0
 * and hides once v > 0. Alpha is clamped (overshooting easings), the scale and blur never go below 0.
 */
export function phaseLook(a: TextAnim, phase: Phase, p: number): PhaseLook {
  if (a.effect === 'typewriter') return { ...REST, alpha: (phase === 'in' ? p > 0 : !(p > 0)) ? 1 : 0 };
  const e = applyEasing(a.easing, p, a.duration);
  const there = phase === 'in' ? e : 1 - e;
  const away = phase === 'in' ? 1 - e : e;
  const look: PhaseLook = { ...REST, alpha: clamp01(there) };
  // `+ 0` turns −0 into 0, so a unit at rest has exactly the rest values.
  if (a.effect === 'rise') look.dy = (phase === 'in' ? away : -away) * a.distance + 0;
  else if (a.effect === 'drop') look.dy = (phase === 'in' ? -away : away) * a.distance + 0;
  else if (a.effect === 'scale') look.scale = Math.max(0, there);
  else if (a.effect === 'blur') look.blur = Math.max(0, away * a.distance);
  return look;
}

/** A unit's final look: opacity, the map p → s·p + (tx, ty) in layer coordinates, and its blurs (layer px, chained). */
export interface UnitLook {
  alpha: number;
  s: number;
  tx: number;
  ty: number;
  blurs: number[];
}

/**
 * Compose phase looks (in, then out) on one unit. Each phase scales about the centre of its own unit (a word that
 * grows grows as a whole, even when its letters are drawn one by one) and moves by its dy; opacities multiply and the
 * blurs are chained (filter "blur(a) blur(b)").
 */
export function composeLooks(parts: { look: PhaseLook; cx: number; cy: number }[]): UnitLook {
  const out: UnitLook = { alpha: 1, s: 1, tx: 0, ty: 0, blurs: [] };
  for (const { look, cx, cy } of parts) {
    const k = look.scale;
    out.alpha *= look.alpha;
    out.s *= k;
    out.tx = k * out.tx + cx * (1 - k);
    out.ty = k * out.ty + cy * (1 - k) + look.dy;
    if (look.blur > 0) out.blurs.push(look.blur);
  }
  return out;
}

// ---------------------------------------------------------------- caret

/** The caret stays this long after the text is fully typed, and shows this long before a typewriter-out starts. */
export const CARET_HOLD = 1;
/** Caret bar, as fractions of the font size: gap after the last character, width, height (centred on the line). */
export const CARET = { gap: 0.04, width: 0.07, height: 1 } as const;

/** Blinks with a 1 s period, from layer-local time (on for the first half of each second). */
export const caretBlinkOn = (local: number) => local - Math.floor(local) < 0.5;

/**
 * Like a real text cursor: solid while letters are typed (or deleted), from `from` to `to` (the first and the last
 * keystroke); blinking otherwise, counted from the layer's start before typing and from the last keystroke after it.
 */
export function caretShows(local: number, from: number, to: number): boolean {
  if (local >= from && local <= to) return true;
  return caretBlinkOn(local > to ? local - to : local);
}

// ---------------------------------------------------------------- timing state (no measuring)

export interface TextAnimTiming {
  /** Some unit of the in / out phase is not at rest (u < 1, or a typewriter unit not shown yet; v > 0). */
  inActive: boolean;
  outActive: boolean;
  /** The typewriter caret is showing (inside its window; solid while typing, blinked on otherwise — caretShows). */
  caret: boolean;
}

/** Which parts of a text layer's animation run at layer-local time `local`. Cheap: splits the text, measures nothing. */
export function textAnimTiming(layer: TextLayer, local: number): TextAnimTiming {
  const { textIn: a, textOut: b } = layer;
  let inActive = false;
  let outActive = false;
  let caret = false;
  if (a) {
    const n = splitUnits(layer.content, a.unit).length;
    if (n > 0) {
      // The last rank starts last; once it is in place (typewriter: shown), every unit is.
      const u = unitProgress(a, 'in', n - 1, n, local, layer.duration);
      inActive = a.effect === 'typewriter' ? !(u > 0) : u < 1;
    }
    if (a.effect === 'typewriter' && a.caret) {
      // The last letter appears at `typed`.
      const typed = a.delay + Math.max(0, n - 1) * a.stagger;
      if (local < typed + CARET_HOLD) caret = caretShows(local, a.delay, typed);
    }
  }
  if (b) {
    const n = splitUnits(layer.content, b.unit).length;
    // Rank 0 leaves first.
    if (n > 0) outActive = unitProgress(b, 'out', 0, n, local, layer.duration) > 0;
    if (b.effect === 'typewriter' && b.caret) {
      const from = outStart(b, n, layer.duration);
      if (local >= from - CARET_HOLD) caret = caretShows(local, from, from + Math.max(0, n - 1) * b.stagger);
    }
  }
  return { inActive, outActive, caret };
}

function activePhases(layer: TextLayer, t: TextAnimTiming): { a: TextAnim; phase: Phase }[] {
  const out: { a: TextAnim; phase: Phase }[] = [];
  if (t.inActive && layer.textIn) out.push({ a: layer.textIn, phase: 'in' });
  if (t.outActive && layer.textOut) out.push({ a: layer.textOut, phase: 'out' });
  return out;
}

/** True while anything of the animation is drawn (units moving or the caret): the layer then paints several times. */
export function textAnimating(layer: TextLayer, local: number): boolean {
  if (!layer.textIn && !layer.textOut) return false;
  const t = textAnimTiming(layer, local);
  return t.inActive || t.outActive || t.caret;
}

// ---------------------------------------------------------------- layout & frame (measuring)

/** A unit placed in the layer box (drawn with textAlign 'left', textBaseline 'middle' at x, y). */
export interface PlacedUnit extends UnitSpan {
  x: number;
  y: number;
  /** On a right-to-left line: drawn with ctx.direction 'rtl', and the first unit is the rightmost. */
  rtl?: true;
  /** Advance width. */
  width: number;
  /** Glyph box at rest (actualBoundingBox), layer-box coordinates. */
  ink: Box;
}

const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/**
 * Lay out the units of `kind` exactly where whole-line drawing puts their glyphs. Unit x on its line is
 * measureText(prefix + unit) − measureText(unit): that keeps the kern pair between the prefix and the unit (the naive
 * measureText(prefix) is off by up to ~14 px for 'AVATAR'). Letters lose ligatures / contextual alternates while they
 * animate (they are drawn one by one).
 */
export function layoutUnits(ctx: Ctx2D, layer: TextLayer, kind: UnitKind): PlacedUnit[] {
  ctx.save();
  ctx.font = fontString(layer);
  setLetterSpacing(ctx, layer.letterSpacing);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lines = layer.content.split('\n');
  const widths = lines.map((l) => ctx.measureText(l).width);
  const w = Math.max(1, ...widths);
  const lh = layer.fontSize * layer.lineHeight;
  const out: PlacedUnit[] = [];
  lines.forEach((line, li) => {
    const lx = lineX(layer.align, w, widths[li]);
    const y = li * lh + lh / 2;
    const rtl = lineIsRtl(line);
    if (rtl) ctx.direction = 'rtl';
    for (const u of lineUnits(line, kind)) {
      const m = ctx.measureText(u.text);
      const through = u.start > 0 ? ctx.measureText(line.slice(0, u.start + u.text.length)).width : m.width;
      // Right to left, the text before a unit lies to its right.
      const x = rtl ? lx + widths[li] - through : lx + through - m.width;
      const ink = u.text.trim()
        ? { x0: x - finite(m.actualBoundingBoxLeft, 0), x1: x + finite(m.actualBoundingBoxRight, m.width), y0: y - finite(m.actualBoundingBoxAscent, layer.fontSize), y1: y + finite(m.actualBoundingBoxDescent, layer.fontSize) }
        : EMPTY_BOX;
      out.push({ line: li, start: u.start, end: u.start + u.text.length, text: u.text, x, y, width: m.width, ink, ...(rtl ? { rtl: true as const } : {}) });
    }
    if (rtl) ctx.direction = 'inherit';
  });
  ctx.restore();
  return out;
}

/** Horizontal centre a unit scales about: its glyphs' centre (a word's trailing space doesn't count), else its advance. */
const centreX = (u: PlacedUnit) => (u.ink.x1 > u.ink.x0 ? (u.ink.x0 + u.ink.x1) / 2 : u.x + u.width / 2);

export interface DrawUnit extends PlacedUnit {
  look: UnitLook;
}

export interface TextAnimFrame {
  /** Units to draw one by one, in reading order; null = nothing is moving, draw whole lines exactly like v1. */
  units: DrawUnit[] | null;
  /** The caret bar in layer-box coordinates, or null. */
  caret: Box | null;
}

/**
 * Everything an animated text layer draws at layer-local time `local`. Units come from the active phase; when the in
 * and out phases overlap (a short layer) they use the finer of the two unit kinds and compose both looks
 * (visibility e_in · (1 − e_out)).
 */
export function textAnimFrame(ctx: Ctx2D, layer: TextLayer, local: number): TextAnimFrame {
  if (!layer.textIn && !layer.textOut) return { units: null, caret: null };
  const timing = textAnimTiming(layer, local);
  const active = activePhases(layer, timing);
  if (!active.length && !timing.caret) return { units: null, caret: null };
  let units: DrawUnit[] | null = null;
  if (active.length) {
    const kind = active.map((p) => p.a.unit).reduce(finer);
    const placed = layoutUnits(ctx, layer, kind);
    const phases = active.map(({ a, phase }) => {
      const own = a.unit === kind ? placed : layoutUnits(ctx, layer, a.unit);
      const ranks = unitRanks(own.length, a.order, a.seed);
      const looks = own.map((_, j) => phaseLook(a, phase, unitProgress(a, phase, ranks[j], own.length, local, layer.duration)));
      // Drawn unit → the unit of this phase that contains it (−1: blank text outside every unit of this kind).
      const index = a.unit === kind ? null : placed.map((u) => own.findIndex((c) => c.line === u.line && c.start <= u.start && u.start < c.end));
      return { own, looks, index };
    });
    units = placed.map((u, i) => {
      const parts = phases.map(({ own, looks, index }) => {
        const j = index ? index[i] : i;
        return j < 0 ? { look: REST, cx: 0, cy: 0 } : { look: looks[j], cx: centreX(own[j]), cy: own[j].y };
      });
      return { ...u, look: composeLooks(parts) };
    });
  }
  return { units, caret: timing.caret ? caretBox(ctx, layer, units) : null };
}

/** The caret bar after the last visible character (at the start of the text before anything shows). */
function caretBox(ctx: Ctx2D, layer: TextLayer, units: DrawUnit[] | null): Box {
  // ax = where the text ends so far; right to left, the text grows leftwards and the caret sits on its left.
  let ax: number;
  let ay: number;
  let rtl: boolean;
  if (units?.length) {
    let last = units.length - 1;
    while (last >= 0 && !(units[last].look.alpha > 0)) last--;
    const u = units[Math.max(0, last)];
    rtl = !!u.rtl;
    const end = last >= 0;
    ax = rtl === end ? u.x : u.x + u.width;
    ay = u.y;
  } else {
    // The whole text shows: after the end of the last line that has any characters.
    const m = measureText(ctx, layer);
    let li = m.lines.length - 1;
    while (li > 0 && !m.lines[li].text) li--;
    const line = m.lines[li];
    rtl = lineIsRtl(line.text);
    ax = lineX(layer.align, m.w, line.width) + (rtl ? 0 : line.width);
    ay = li * m.lineHeightPx + m.lineHeightPx / 2;
  }
  const fs = layer.fontSize;
  const x0 = rtl ? ax - (CARET.gap + CARET.width) * fs : ax + CARET.gap * fs;
  return { x0, x1: x0 + CARET.width * fs, y0: ay - (CARET.height * fs) / 2, y1: ay + (CARET.height * fs) / 2 };
}

// ---------------------------------------------------------------- bounds (inkBounds)

/** Range [lo, hi] an easing's value can reach on 0..1 (springs and custom curves overshoot). */
export function easingRange(e: Easing): [number, number] {
  // A Bézier curve stays inside the hull of its control points.
  if (e.type === 'cubicBezier') return [Math.min(0, e.y1, e.y2), Math.max(1, e.y1, e.y2)];
  if (e.type === 'spring') {
    // From rest a damped spring first peaks at 1 + exp(−ζπ/√(1−ζ²)) and never dips below 0.
    const zeta = e.damping / (2 * Math.sqrt(e.stiffness * e.mass));
    return [0, zeta < 1 ? 1 + Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta)) : 1];
  }
  return [0, 1];
}

/** How far past its rest look a phase can push a unit, as a multiple of `distance` (or of the scale): 1 unless it overshoots. */
export function overshoot(a: TextAnim): number {
  if (a.effect === 'typewriter') return 1;
  const [lo, hi] = easingRange(a.easing);
  return Math.max(1 - lo, hi);
}

export interface TextAnimReach {
  /** Vertical travel (layer px) and the largest unit scale (≥ 1). */
  dy: number;
  scale: number;
  /** Largest blur of each blurring phase (layer px; chained when both phases blur). */
  blurs: number[];
  caret: boolean;
}

/** How far animated units can reach beyond the text's rest ink at `local` (for inkBounds). Nothing when at rest. */
export function textAnimReach(layer: TextLayer, local: number): TextAnimReach {
  const reach: TextAnimReach = { dy: 0, scale: 1, blurs: [], caret: false };
  if (!layer.textIn && !layer.textOut) return reach;
  const t = textAnimTiming(layer, local);
  for (const { a } of activePhases(layer, t)) {
    const f = overshoot(a);
    if (a.effect === 'rise' || a.effect === 'drop') reach.dy += Math.abs(a.distance) * f;
    else if (a.effect === 'scale') reach.scale *= f;
    else if (a.effect === 'blur') reach.blurs.push(Math.abs(a.distance) * f);
  }
  reach.caret = t.caret;
  return reach;
}

/** Every place the caret can be (layer-box coordinates, with a little slack): anywhere along the lines. */
export function caretRegion(layer: TextLayer, box: { w: number; h: number }): Box {
  const fs = layer.fontSize;
  const lh = fs * layer.lineHeight;
  const lines = layer.content.split('\n').length;
  const half = (CARET.height * fs) / 2;
  const reach = (CARET.gap + CARET.width + 0.1) * fs;
  return { x0: -reach, x1: box.w + reach, y0: lh / 2 - half, y1: (lines - 1) * lh + lh / 2 + half };
}

// ---------------------------------------------------------------- styles

export interface TextAnimStyle {
  id: string;
  label: string;
  phase: Phase;
  /** The animator; `distance` is a multiple of the font size. */
  anim: TextAnim;
}

const easeOut: Easing = { type: 'easeOut' };
const anim = (a: Omit<TextAnim, 'delay' | 'seed' | 'caret' | 'distance' | 'order'> & Partial<TextAnim>): TextAnim => ({ order: 'forward', delay: 0, distance: 0, seed: 1, caret: false, ...a });

/** Ready-made animators shown in the Style menus (the first of each phase is the suggested one). */
export const TEXT_ANIM_STYLES: readonly TextAnimStyle[] = [
  { id: 'words-rise', label: 'Words rise', phase: 'in', anim: anim({ unit: 'word', effect: 'rise', stagger: 0.08, duration: 0.5, distance: 0.5, easing: easeOut }) },
  { id: 'letters-fade', label: 'Letters fade', phase: 'in', anim: anim({ unit: 'char', effect: 'fade', stagger: 0.03, duration: 0.4, easing: easeOut }) },
  { id: 'typewriter', label: 'Typewriter', phase: 'in', anim: anim({ unit: 'char', effect: 'typewriter', stagger: 0.05, duration: 0.05, easing: { type: 'linear' }, caret: true }) },
  { id: 'lines-slide-up', label: 'Lines slide up', phase: 'in', anim: anim({ unit: 'line', effect: 'rise', stagger: 0.15, duration: 0.6, distance: 0.6, easing: easeOut }) },
  { id: 'blur-in', label: 'Blur in', phase: 'in', anim: anim({ unit: 'word', effect: 'blur', stagger: 0.06, duration: 0.6, distance: 0.15, easing: easeOut }) },
  { id: 'words-fade-out', label: 'Words fade out', phase: 'out', anim: anim({ unit: 'word', effect: 'fade', stagger: 0.04, duration: 0.3, easing: { type: 'easeIn' } }) },
  { id: 'backspace', label: 'Backspace', phase: 'out', anim: anim({ unit: 'char', effect: 'typewriter', order: 'reverse', stagger: 0.03, duration: 0.03, easing: { type: 'linear' } }) },
];

export const stylesFor = (phase: Phase) => TEXT_ANIM_STYLES.filter((s) => s.phase === phase);

export const findStyle = (id: string) => TEXT_ANIM_STYLES.find((s) => s.id === id);

/** The animator a style makes for text of `fontSize` px (whole-pixel distances); `keep` carries the user's delay/seed over. */
export function styleAnim(style: TextAnimStyle, fontSize: number, keep: Partial<Pick<TextAnim, 'delay' | 'seed'>> = {}): TextAnim {
  return { ...style.anim, easing: { ...style.anim.easing }, distance: Math.round(style.anim.distance * fontSize), ...keep };
}

const sameEasing = (a: Easing, b: Easing) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The style an animator matches (same unit, effect, order, gap, length and easing; typewriters also the caret), or null
 * when it has been customised. Delay, distance (it follows the font size) and seed don't count.
 */
export function matchStyle(a: TextAnim, phase: Phase): TextAnimStyle | null {
  return (
    stylesFor(phase).find(({ anim: s }) => {
      if (s.unit !== a.unit || s.effect !== a.effect || s.order !== a.order || s.stagger !== a.stagger) return false;
      return s.effect === 'typewriter' ? s.caret === a.caret : s.duration === a.duration && sameEasing(s.easing, a.easing);
    }) ?? null
  );
}
