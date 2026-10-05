# Motion Studio v2 — design spec

Status: **draft for critique**. This is the contract that implementation agents build against.
Principles carried over from v1 (non-negotiable):

- `project.json` (zod) is the single source of truth. Old (v1) files must keep opening.
- `renderFrame(project, t, ctx, scale, resources)` stays **pure and deterministic**: no clocks, no unseeded randomness,
  no accumulated state. Preview and export both use it. Text/vectors stay crisp at any `scale`.
- Every edit is one undo step; one drag is one undo step.
- Everything works offline. No AI/API calls.
- Every feature ships with automated tests that actually run (unit and/or Playwright), and the README lists as
  "Works (tested)" only what passed.

---

## 0. Schema v2 (done in the foundation step, before lanes start)

`SCHEMA_VERSION = 2`. `ProjectSchema = z.preprocess(migrateToLatest, ProjectV2Schema)` so every existing
`ProjectSchema.parse(...)` call migrates automatically. Migration v1→v2 only bumps `schemaVersion`; every new field has a
zod `.default(...)` (function form for objects) so v1 data fills in. `ProjectInput` (`z.input` of the v2 object schema) is
exported for test fixtures.

### New fields

All layers (`LayerBase`):

| field | type | default | animatable |
|---|---|---|---|
| `blur` | number ≥ 0 (project px) | 0 | yes |
| `shadowColor` | colour (#rrggbbaa) | `#00000000` (none) | yes |
| `shadowBlur` | number ≥ 0 (project px) | 0 | yes |
| `shadowOffsetX` / `shadowOffsetY` | number (project px, screen-space, not rotated with the layer) | 0 | yes |
| `blendMode` | `normal multiply screen overlay darken lighten color-dodge color-burn hard-light soft-light difference exclusion hue saturation color luminosity` | `normal` | no |

Text layers: `fillMode: 'solid'|'linear'` (`solid`), `gradientTo` colour (`#ffffff`), `gradientAngle` deg (`90`, 0 = left→right,
90 = top→bottom), `stroke` colour (`#000000`), `strokeWidth` ≥ 0 (`0`), `textIn: TextAnim|null` (`null`),
`textOut: TextAnim|null` (`null`).

`TextAnim = { unit: 'char'|'word'|'line', effect: 'fade'|'rise'|'drop'|'scale'|'typewriter'|'blur', order: 'forward'|'reverse'|'center'|'edges'|'random', stagger ≥0 s, duration >0 s, delay ≥0 s, distance number (px, for rise/drop/blur), easing: Easing, seed: int }`.

Shape layers: `shape` enum grows to `rect | ellipse | triangle | star | polygon | line`; new `points` int 3..64 (`5`),
`innerRadius` 0..1 (`0.45`), `fillMode`/`gradientTo`/`gradientAngle` as text, `trimStart` 0..1 (`0`), `trimEnd` 0..1 (`1`),
`trimOffset` number (`0`, wraps), `lineCap: butt|round|square` (`round`).

Scenes: `background: colour|null` (`null` = show project background), `transition: { type: 'none'|'fade'|'slide'|'push'|'wipe'|'zoom'|'blur', duration > 0 s, direction: 'left'|'right'|'up'|'down', easing: Easing }`
(default `{none, 0.6, left, easeInOut}`).

Assets: `type` adds `'audio'`; new optional `duration` (seconds; audio).

Project: `audio: AudioClip[]` (`[]`). `AudioClip = { id, name, assetId, start ≥0 (project s), trimStart ≥0 (s into source), duration > 0, volume 0..4 (linear gain, 1 = original), fadeIn ≥0, fadeOut ≥0, muted: boolean }`. Array order = row order.

`ANIMATABLE` (v2):
- all types gain `blur shadowColor shadowBlur shadowOffsetX shadowOffsetY`
- text: + `gradientTo gradientAngle stroke strokeWidth`
- image: + `width height`
- shape: + `innerRadius trimStart trimEnd trimOffset stroke strokeWidth gradientTo gradientAngle`
- cursor: `opacity scale` + effects

---

## Lane A — rendering engine (owner of `src/shared/renderFrame.ts` and new `src/shared/*` render modules)

### A1. Layer effects, scene background, scene transitions

**drawLayer(ctx, layer, local, res, scale)** (signature gains `scale`):
- `blendMode` → `ctx.globalCompositeOperation` (`normal` → `source-over`).
- `blur > 0` → `ctx.filter = blur(${blur*scale}px)` (filter radius is in canvas pixels, so multiply by render scale).
- shadow when `alpha(shadowColor) > 0` and (`shadowBlur > 0` or any offset ≠ 0): `ctx.shadowColor/shadowBlur*scale/shadowOffsetX*scale/shadowOffsetY*scale`.
- Applies to every layer type including cursor.

**Scene background**: if `scene.background` is set, fill the full frame with it before the scene's layers.

**Transitions** ("transition in" on the incoming scene `S`):
- Window: `t ∈ [S.start, S.start + d)` with `d = min(transition.duration, S.duration)`; progress `p = applyEasing(easing, (t-S.start)/d, d)`.
- Outgoing partner `P(S)`: among other scenes with `start < S.start` and `end ≥ S.start − 1e-6`, the one with the greatest `end`
  (ties → later in array). None → outgoing is just the project background.
- `P` is drawn at local time `min(t − P.start, P.duration − 1e-6)` (holds its last frame if it already ended), **without** its own
  transition, and `P`'s normal entry is skipped while it is the partner of a transitioning scene.
- Compositing uses offscreen canvases the size of `ctx.canvas` (factory: `res.createCanvas?.(w,h)`, else `OffscreenCanvas`,
  else `document.createElement('canvas')`), so groups composite correctly (no per-layer alpha bleed):
  - `fade`: O; then I with alpha `p`.
  - `slide`: O; then I translated by `(1−p)·W` (or H) opposite to the travel direction (direction = direction of travel, like presets).
  - `push`: O translated by `−p·W`, I by `(1−p)·W`.
  - `wipe`: O; I clipped to a rect that grows along the travel direction.
  - `zoom`: O; I scaled `1.25 → 1` about the frame centre with alpha `p`.
  - `blur`: O blurred `p·B` with alpha `1−p`… (B = 3% of the long edge, project px), then I blurred `(1−p)·B` with alpha `p`.
- Outside the window the scene draws normally. `type: 'none'` = hard cut (v1 behaviour).

**UI**: Properties → Scene → "Background" (checkbox "use project background" + colour) and "Transition in" (type, duration,
direction, easing picker). Layer Properties → "Effects" section (blur, drop-shadow toggle + colour/blur/offsets with ◆
keyframe toggles, blend mode). Timeline: transition window drawn as a hatched strip at the start of the scene block.

### A2. Text animators

- `textIn` animates units **in** starting `delay` s after the layer starts; `textOut` animates them **out** ending `delay` s
  before the layer ends. Total span = `(n−1)·stagger + duration`.
- Units: `char` (grapheme via `Intl.Segmenter` when available, else `Array.from`), `word` (whitespace-separated, spaces stay
  attached to the preceding word for layout), `line`.
- Layout: unit x-offset = `measureText(prefix)` on its line with the same font/letterSpacing (so kerning up to the unit is kept);
  the text box (`layerBox`) is unchanged by animators.
- Order index: forward `i`; reverse `n−1−i`; center `|i − (n−1)/2|` (ranked); edges = reverse of center; random = seeded
  permutation (mulberry32, `seed`).
- Unit progress `u = clamp((local − delay − rank·stagger)/duration)`, eased `e = applyEasing(easing, u, duration)`; out-phase uses
  `1 − e` measured from the end.
- Effects: fade (alpha `e`), rise (y `+(1−e)·distance`, alpha `e`), drop (y `−(1−e)·distance`, alpha `e`), scale (about unit centre
  `0→1`, alpha `e`), typewriter (unit visible iff `u > 0`, no easing), blur (`blur((1−e)·distance·scale px)`, alpha `e`).
- When every unit is fully in (and no out-phase active) draw the whole lines exactly as v1 does → identical pixels to a layer
  without animators.
- **UI**: Properties → Text → "Animate text in / out" (unit, effect, order, stagger, duration, delay, distance, easing, seed).

### A3. Shapes v2, trim paths, gradients, text stroke

- New shapes (in the layer box `w×h`): triangle `(w/2,0) (w,h) (0,h)`; polygon (`points` sides, vertex 0 at top, radii `w/2`,`h/2`);
  star (`points` tips, inner radius `innerRadius × outer`); line `(0,h/2)→(w,h/2)`, stroke only.
- Trim paths (stroke only, all shapes): exact path length `L` (rounded rect = `2(w+h) − 8r + 2πr`; ellipse = Ramanujan II;
  polygons/star/triangle/line exact). Visible length `v = (trimEnd − trimStart)·L`; `setLineDash([v, L − v])`,
  `lineDashOffset = −(trimStart + trimOffset)·L` (wraps). `v ≤ 0` → no stroke; `v ≥ L` → solid. Path start points/direction
  documented in code (rect starts top-left corner after radius, clockwise; ellipse at 3 o'clock, clockwise).
- Linear gradient fill (`fillMode: 'linear'`) for shapes and text: through the box centre at `gradientAngle`, half-length
  `(|w cosθ| + |h sinθ|)/2`, stops `0 = fill/color`, `1 = gradientTo`.
- Text stroke: `strokeText` drawn **before** the fill with `lineJoin = round`, width `strokeWidth`.
- **UI**: shape type select gains the new types, with `points`/`innerRadius` fields when relevant; "Trim path" fields; fill mode + gradient
  fields; text stroke fields. The toolbar gets a "+ Shape ▾" menu (foundation step adds it).

---

## Lane B — app, audio, UX and infrastructure (owner of `src/app/*` except Properties sub-sections listed for lane A, `server/*`, `src/render/*`)

### B1. Audio

- Import `.mp3 .wav .ogg .m4a .aac .flac` (byte-for-byte, like other assets). Duration read client-side by decoding
  (`OfflineAudioContext.decodeAudioData`). A clip is added at the playhead, `duration = asset duration`.
- Pure planner `src/shared/audioPlan.ts`: `planAudio(project, fromTime) → [{clipId, assetId, when (s from fromTime), offset (s into
  source), duration, gain, fadeIn/out windows}]` — used by the preview engine; unit-tested.
- Preview engine `src/app/audio/engine.ts` (Web Audio): starts/stops with playback, restarts on loop wrap / seek / audio edits;
  global mute toggle (not saved in the project). The playhead clock stays `performance.now()`-based (no dependency on an audio device).
- Waveform `src/app/audio/waveform.ts`: peaks cached per asset; drawn in the timeline audio rows for the trimmed region.
- Timeline: "Audio" section with one row per clip: drag to move, left edge trims (start + trimStart move together, end fixed), right edge
  changes duration (≤ asset duration − trimStart), click selects. Properties → audio clip (name, start, trim, duration, volume %,
  fade in/out, mute, delete).
- Selection gains `audioIds`; selecting layers clears it and vice versa; Delete removes selected clips.
- Export: `server/audioMix.ts` builds ffmpeg inputs + `filter_complex` per clip:
  `atrim=start=trimStart:duration=dur,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=v,afade=in…,afade=out…,adelay=ms:all=1`,
  then `amix=inputs=n:normalize=0:duration=longest,apad,atrim=0:projectDuration` → AAC 192k 48 kHz. No audible clips → no audio stream.
  Missing audio files are skipped with a warning on the job. CLI gets the same.

### B2. Timeline & preview UX

- Per-property keyframe rows: a ▸ toggle on each layer row expands one row per animated property; dragging a diamond there moves
  only that keyframe. Keyframe selection (`selectedKeys` in store): click / Shift-click; Delete removes them; Ctrl+C / Ctrl+V copies
  keyframes and pastes them at the playhead onto the selected layer (same properties, relative timing kept); Properties shows an
  easing picker for the selected keyframes.
- Snapping in the preview (move gesture): selection bounds (left/centre/right, top/middle/bottom) snap to the frame edges/centre and to
  other visible layers' bounds within 8 screen px; magenta guide lines while snapped; hold Ctrl/Cmd to disable; toggle in UI.
- Snapping in the timeline: bar/clip/scene edges and keyframes snap to the playhead, scene boundaries, other bars' edges and
  keyframes within 8 px (Ctrl disables).
- Guides overlay toggle: centre lines, rule of thirds, title-safe (90%) and action-safe (93%) boxes.
- Marquee selection: dragging on empty preview space selects layers whose bounds intersect (Shift adds).
- Adding the first layer to an empty project creates scene + layer as **one** undo step.

### B3. Export options, Windows hardening, CI

- Export dialog: resolution scale (100/50/25%), quality (High CRF 16 / Medium CRF 20 / Draft CRF 26 + `veryfast`), include audio.
  Output size = even-rounded `W·s × H·s`. CLI flags `--scale`, `--crf`, `--no-audio`.
- "Export frame (PNG)" — current frame at full project resolution via `renderFrame` in the editor.
- Windows: tests spawn tsx through `process.execPath` (no bare `npx`), `sanitizeName` rejects Windows reserved names
  (CON, PRN, AUX, NUL, COM1–9, LPT1–9) and trailing dots/spaces, Vite watch-ignore paths use forward slashes,
  `.gitattributes` keeps binaries binary and text LF.
- GitHub Actions `ci.yml`: matrix `ubuntu-latest` + `windows-latest`, Node 22, ffmpeg, `npm ci`, typecheck, unit, Playwright.

---

## Explicitly still out of scope

Video clips as layers, AI generation, cloud sync (kept in the UI's "Not available" list).

## Testing contract per feature

- A1: unit (recording ctx) for partner selection, effect state, background; Playwright: export-vs-renderFrame pixel match on frames
  inside a transition window and with blur/shadow layers; determinism.
- A2: unit for unit layout, order ranks, timing, "fully revealed = identical draw calls to no animator"; export match mid-animation.
- A3: unit for path lengths (vs numeric integration), dash/offset maths, gradient endpoints; export match with trim + gradient.
- B1: unit for `planAudio` and `buildAudioArgs`; Playwright: import WAV via UI → row + waveform + properties; export with audio →
  AAC stream, silence/signal RMS windows match the clip placement, trim respected.
- B2: Playwright for keyframe rows, key selection/delete/copy-paste/easing, snapping (exact centre), Ctrl disables, guides, marquee,
  timeline snapping, single-undo first layer.
- B3: Playwright for scaled export dimensions + CLI flags + PNG still; unit for `sanitizeName`.
