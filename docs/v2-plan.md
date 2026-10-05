# Motion Studio v2 — design spec

Status: **revised after critique round 1** (UX/product critic + feasibility critic, whose experiments live in
`/tmp/.../scratchpad/critique/feasibility/`). This is the contract that implementation agents build
against. Principles carried over from v1 (non-negotiable):

- `project.json` (zod) is the single source of truth. Old (v1) files must keep opening.
- `renderFrame(project, t, ctx, scale, resources)` stays **pure and deterministic**: no clocks, no unseeded randomness,
  no accumulated state. Preview and export both use it. Text/vectors stay crisp at any `scale`.
- Every edit is one undo step; one drag is one undo step.
- Everything works offline. No AI/API calls.
- Every feature ships with automated tests that actually run (unit and/or Playwright), and the README lists as
  "Works (tested)" only what passed.
- The user is a freelancer making short SaaS promo videos, not a motion-design expert, and has ADHD: **plain labels,
  sensible defaults that look good immediately, few decisions before something moves, little clutter.**

---

## 0. Schema v2 (DONE in the foundation commit — build on it, don't redesign it)

`SCHEMA_VERSION = 2`. `ProjectSchema = z.preprocess(migrateProject, ProjectV2Schema)`; v1 → v2 only bumps
`schemaVersion`, zod defaults fill every new field. Factories `makeLayer/makeScene/makeProject` (src/shared/factories.ts)
fill defaults for code and tests. `ProjectInput`/`LayerInput`/`SceneInput` are the input types for fixtures.

New fields (all with defaults):

- All layers: `blur` (px), `shadow: boolean` (on/off, default false), `shadowColor` (`#00000040`), `shadowBlur`,
  `shadowOffsetX`, `shadowOffsetY` (px, screen-space), `blendMode` (16 CSS modes, `normal`).
- Text: `fillMode: 'solid'|'linear'`, `gradientTo`, `gradientAngle` (deg; 0 = →, 90 = ↓), `stroke`, `strokeWidth`,
  `textIn`/`textOut: TextAnim|null`.
  `TextAnim = { unit: char|word|line, effect: fade|rise|drop|scale|typewriter|blur, order: forward|reverse|center|edges|random, stagger, duration, delay, distance, easing, seed, caret }`.
- Shape: `shape: rect|ellipse|triangle|star|polygon|line`, `points`, `innerRadius`, `fillMode`, `gradientTo`,
  `gradientAngle`, `trimStart`, `trimEnd`, `trimOffset`, `lineCap`.
- Scene: `background: colour|null`, `transition: { type: none|fade|slide|push|wipe|zoom|blur, duration, direction: left|right|up|down, easing }`.
- Asset: `type` adds `audio`; `duration?`.
- Project: `audio: AudioClip[]` where `AudioClip = { id, name, assetId, start, trimStart, duration, volume (linear 0..4), fadeIn, fadeOut, muted }`.
- `ANIMATABLE` covers: effects on every type (`blur shadowColor shadowBlur shadowOffsetX shadowOffsetY`), text
  `gradientTo gradientAngle stroke strokeWidth`, image `width height`, shape `innerRadius trimStart trimEnd trimOffset stroke strokeWidth gradientTo gradientAngle`.

Also already in the foundation: Properties panel split into `src/app/components/props/*` with placeholder components,
"+ Shape ▾" toolbar menu, transition strip in the timeline, first layer + scene = one undo step, store
`previewRange(start, end)` + `playUntil` (play a range once and stop — for "▶ Preview" buttons), default cursor drop
shadow, audio assets skipped by the image/font loader, `tests/e2e/exportCompare.ts` helpers, v1 migration tests,
`src/shared/canvas.ts` `createRenderCanvas` / `RENDER_CONTEXT_OPTIONS` (`{alpha:true, willReadFrequently:true}`, used by
render.html; use it for every offscreen too), Playwright launched with `--disable-gpu` like the exporter.

---

## Lane A — rendering engine

Owns: `src/shared/renderFrame.ts`, new `src/shared/*` render modules (`effects`, `transitions`, `textAnim`, `shapes`, …),
`src/shared/presets.ts`, and the Properties sections `props/{EffectsSection,SceneExtras,TextAnimSection,TextSection,ShapeSection,ImageSection,PresetPanel,LayerProps}.tsx`.

### A1. Layer effects, scene background, scene transitions

**Effects in drawLayer(ctx, layer, local, res, scale)** (signature gains `scale`):
- Effective size factor `k = scale × |layer.scale|` (render scale × the layer's own scale resolved at t, for every layer
  type including the cursor). Blur radius, shadow blur and shadow offsets are multiplied by `k` so they shrink/grow with
  the layer (like CSS/After Effects). Offsets stay screen-space (not rotated).
- `blendMode` → `globalCompositeOperation` (`normal` → `source-over`).
- `blur > 0` → `ctx.filter = blur(${blur·k}px)`. Filters compose as a chain (`blur(a) blur(b)`) when a text unit adds its own.
- Shadow drawn only when `layer.shadow === true` and `alpha(shadowColor) > 0`.
- **Clamp resolved values** (spring/bezier easing overshoots, and canvas silently ignores invalid assignments, keeping the
  previous value): blur, shadowBlur, strokeWidth ≥ 0; alphas to [0,1]; trimStart/trimEnd to [0,1].
- **Isolation for multi-draw layers** (verified: per-call shadows/blends are wrong — a stroked rect's stroke shadow lands
  inside its own fill; the default cursor's shadow darkens its own white arrow; per-char shadows differ from whole-line):
  when an effect is active (shadow on, blur > 0, or blendMode ≠ normal) AND the layer issues more than one draw call
  (shape with strokeWidth > 0, text with outline or > 1 line or an active animator, cursor, missing-image placeholder),
  draw the layer with plain source-over / no shadow / no filter / opacity 1 into a scratch canvas (`createRenderCanvas`,
  bounded to the transformed box + a margin of 3× the blur/shadow extent), then `drawImage` it once at identity with
  shadow, filter, `globalCompositeOperation` and `globalAlpha` set. Single-draw layers keep the direct path, so v1
  files (no effects) render exactly as before. Playwright check: a stroked rect with a shadow keeps its fill colour.

**Scene background**: `scene.background` set → fill the whole frame with it before the scene's layers.

**Transitions** ("transition into this scene", on the incoming scene `S`):
- Window `t ∈ [S.start, S.start + d)`, `d = min(transition.duration, S.duration)`;
  `p = applyEasing(easing, (t − S.start)/d, d)`.
- **Outgoing partner `P(S)`**: candidates are other scenes with `start < S.start` whose **end lies inside the window**:
  `S.start − 1e-6 ≤ end ≤ S.start + d`. Pick the greatest end (ties → later in array). Scenes running past the window
  (e.g. a long logo/overlay scene) are never partners and keep drawing normally in array order. No partner → the
  incoming scene transitions in over whatever is underneath (e.g. fades in from the background).
- `P` is drawn at local time `min(t − P.start, P.duration − 1e-6)` (holds its last frame if it already ended), **without**
  its own transition, and its normal draw is skipped while it is a partner.
- **Compositing** (revised after experiments: bitmap translate/scale softens text, transparent offscreens break blend
  modes, blurred full frames get transparent edges):
  - Transition geometry is always applied **at draw time as a vector transform** (`ctx.translate` / scale about the
    centre / `ctx.clip`) before drawing a scene's background + layers. Offscreens are only ever composited with
    `drawImage(canvas, 0, 0)` at the identity transform — never translated or scaled as bitmaps.
  - `slide` / `push` / `wipe`: **no offscreens** — draw P and S directly onto the frame with translate/clip, so blend
    modes see the real backdrop and text stays vector. slide: S translated in from the edge by `(1−p)·W` (or H) along the
    travel direction and clipped to the region it covers, P clipped to the region not yet covered. push: P translated by
    `−p·W`, S by `(1−p)·W`. wipe: P clipped to the not-yet-wiped region, S to the wiped region.
  - `fade` / `zoom` / `blur`: render **backdrop-inclusive, opaque** O′ and I′: each offscreen (`createRenderCanvas`, size
    of `ctx.canvas`) first receives a copy of the frame so far (project background + scenes drawn earlier in array
    order), then P's (resp. S's) background + layers; for zoom, I′'s layers are drawn under a vector scale `1.25 → 1`
    about the frame centre. Then **dissolve**: temp ← O′ with `globalAlpha 1−p`, then I′ with
    `globalCompositeOperation 'lighter'`, `globalAlpha p` (with opaque inputs this is an exact cross-fade, no mid-point dip);
    draw temp at identity over the frame. Lower scenes still show because they are baked into O′/I′.
  - `blur` style: O′ blurred `p·B`, I′ blurred `(1−p)·B`, `B = 3%` of the long edge × scale. Render each into a canvas
    **padded by `m = ceil(3·radius)`** on every side, filled with `scene.background ?? project.background` before the
    backdrop/layers are drawn at offset `(m, m)`; blur; composite with `drawImage(src, m, m, W, H, 0, 0, W, H)`, so
    edges don't fade to transparent. (Cost ≈ 430 ms/frame at 4K during the window; acceptable.)
  - Direction = direction of travel: `left` = moves right→left (enters from the right edge).
  - All offscreens/scratch canvases come from `createRenderCanvas` (src/shared/canvas.ts, `{alpha:true,
    willReadFrequently:true}` → grayscale text AA everywhere) or `res.createCanvas` when injected by tests. Any pooling
    must not affect output; canvases used at the same time must be distinct.
- Unit tests: composite at `p→0` equals O alone and at `p→1` equals I alone (within 1/255); partner selection cases
  (sequential, overlapping, gap, long overlay scene, tie).

**UI**
- Scene section "Transition into this scene": `Style` (None (cut) / Cross-fade / Slide over / Push / Wipe / Zoom / Blur),
  `Length (s)` (tooltip: "Plays during the first N s of this scene. The previous scene holds its last frame unless they
  overlap."), `Direction` only for slide/push/wipe with arrow labels (`← Right to left`, `→ Left to right`,
  `↑ Bottom to top`, `↓ Top to bottom`), easing picker, a read-only `From: <scene name>` / `From: background (no scene
  before)` line, `▶ Preview` (store.previewRange(S.start − 0.5, S.start + d + 0.5)), `Apply to all scenes` (copies
  style/length/direction/easing to every scene except the first, one undo step).
- Timeline strip tooltip: `Cross-fade from Hook · 0.6 s`.
- Scene background: `☐ Own background colour` checkbox revealing a colour picker (initialised to the project background).
- Effects section (collapsed unless an effect is active; summary reads `Effects ●` when active): `Blur` (◆),
  `☐ Drop shadow` → when first ticked with all-zero values sets `shadowColor #00000040`, `shadowOffsetY =
  round(0.0075 × short edge)`, `shadowBlur = round(0.022 × short edge)`; rows `Colour` (◆), `Softness` (◆, shadowBlur),
  `Offset` X/Y pair (◆ each); `Blend` select last, grouped with `<optgroup>`s: Normal / Darken (Multiply, Darken, Colour
  burn) / Lighten (Screen, Lighten, Colour dodge) / Contrast (Overlay, Soft light, Hard light) / Difference (Difference,
  Exclusion) / Colour (Hue, Saturation, Colour, Luminosity); tooltip "How this layer mixes with what's behind it.
  Multiply darkens, Screen lightens."
- v1 slide preset direction select uses the same arrow labels.

### A2. Text animators

- In: unit with rank `r` starts at `delay + r·stagger`; `u = clamp((local − start_r)/duration)`, `e = ease(u)`;
  visibility `e`.
- **Out** (explicit): `span = (n−1)·stagger + duration`, `outStart = layer.duration − delay − span`; unit rank `r` starts
  leaving at `outStart + r·stagger`, `v = clamp((local − that)/duration)`, `e = ease(v)` with the easing **as picked
  (not mirrored)**; visibility `1 − e`. Effects keep moving in their direction of travel: rise-out moves further **up**
  (`y − e·distance`), drop-out further down, scale-out shrinks `1 → 0`, blur-out blurs `0 → distance`, typewriter-out
  hides a unit once `v > 0`. Order describes the exit sequence too (forward = first unit leaves first).
- Units: `char` (grapheme via `Intl.Segmenter`, fallback `Array.from`), `word` (whitespace-separated; trailing spaces stay
  with the word), `line`. **Unit x = `measureText(prefix + unit).width − measureText(unit).width`** on its line (same
  font, letterSpacing, kerning) — this keeps the kern pair before the unit (verified 0 px difference vs whole-line
  `fillText` for 'AVATAR Type Wave'; the naive `measureText(prefix)` is off by up to 9 px). Char units break
  ligatures/contextual alternates while animating (documented limitation). `layerBox` unchanged.
- When in and out spans overlap on a short layer: visibility = `e_in · (1 − e_out)`, `outStart` clamped ≥ 0.
- Ranks: forward `i`; reverse `n−1−i`; center = rank by `|i − (n−1)/2|` (ties left first); edges = reverse of center;
  random = seeded permutation (mulberry32 `seed`).
- Effects: fade (alpha), rise (y `+(1−e)·distance` in, alpha), drop (y `−(1−e)·distance` in, alpha), scale (about unit
  centre, alpha), typewriter (visible iff `u > 0`; no easing), blur (`blur((1−e)·distance·k px)`, alpha). Scale/blur
  effects compose with the layer-scale factor `k` from A1.
- `caret` (typewriter only): a bar after the last visible character, blinking with a 1 s period computed from local time
  (deterministic), hidden once the whole text is revealed + 1 s.
- When every unit is fully in and no out-phase is active, draw whole lines exactly like v1 → identical pixels.
- **Styles** (shared, unit-tested table `TEXT_ANIM_STYLES` in `src/shared/textAnim.ts`; distances relative to fontSize):
  In: `Words rise` (default: word/rise/forward, stagger 0.08, duration 0.5, distance 0.5·fontSize, easeOut),
  `Letters fade` (char/fade, 0.03, 0.4, easeOut), `Typewriter` (char/typewriter, stagger 0.05, caret on),
  `Lines slide up` (line/rise, 0.15, 0.6, 0.6·fontSize, easeOut), `Blur in` (word/blur, 0.06, 0.6, 0.15·fontSize, easeOut).
  Out: `Words fade out` (default: word/fade, 0.04, 0.3, easeIn), `Backspace` (char/typewriter/reverse, 0.03).
- **UI** ("Text animation" section, collapsed unless in use): per phase `Animate in` / `Animate out`: a `Style` select
  (None + styles) and `▶ Preview`; raw fields under a collapsed `Customise`: `Animate by` (Letters / Words / Lines),
  `Effect` (Fade / Move up / Move down / Grow / Typewriter / Blur), `Order` (First to last / Last to first / Middle out /
  Edges in / Random), `Gap between letters|words|lines (s)`, `Each takes (s)` (hidden for Typewriter), `Starts after (s)` /
  `Ends before layer end (s)`, `Distance (px)` for Move, `Blur amount (px)` for Blur (hidden otherwise), easing (hidden
  for Typewriter), `Shuffle` seed (Random only), `☐ Caret` (Typewriter only).

### A3. Shapes v2, trim paths, gradients, text outline

- Geometry in the layer box `w×h`: triangle `(w/2,0) (w,h) (0,h)`; polygon (`points` sides, vertex 0 at top, radii
  `w/2`,`h/2`); star (`points` tips, inner radius `innerRadius × outer`); line `(0,h/2)→(w,h/2)`, stroke only.
- Path start points and direction (clockwise on screen): rect starts at the top edge just after the top-left corner
  radius; **ellipse starts at 12 o'clock**; polygon/star/triangle start at vertex 0 (top); line starts at the left end.
- Trim (stroke only): exact length `L` (rounded rect with the **clamped** radius `rr = min(r, w/2, h/2)`:
  `2(w+h) − 8rr + 2π·rr`; ellipse Ramanujan II; others exact). `v = (trimEnd − trimStart)·L` (clamped);
  `setLineDash([v, L − v])`, `lineDashOffset = −(((trimStart + trimOffset) % 1 + 1) % 1)·L` (wrap in JS — Skia keeps the
  dash phase in float32); `v ≤ 0` → no stroke; `v ≥ L` → solid. Verified on native arcs/rounded rects in Chromium:
  ellipse drawn from −π/2 starts at 12 o'clock clockwise, wraps are continuous. Unit test a pill (r > h/2).
- Linear gradient (`fillMode: 'linear'`) for shape fill and text: through the box centre at `gradientAngle`, half-length
  `(|w cosθ| + |h sinθ|)/2`, stops 0 = `fill`/`color`, 1 = `gradientTo`. When the user switches to Gradient and
  `gradientTo` equals the base colour, set `gradientTo` to the base mixed 45% toward black (luminance > 0.5) or white.
- Text outline: `strokeText` before the fill, `lineJoin = round`, width `strokeWidth`; colour row shown only when width > 0.
- **"Draw on" preset**: new preset kind `draw` in `applyPreset` animating `trimEnd` (in: 0→1, out: 1→0).
- **UI**: Shape type select (existing); `Sides` (polygon) / `Points` (star) / `Inner size` (star only) / `Line ends`
  (line, or when trimmed); hide Fill for Line; `Fill` select `Solid | Gradient` with `From` / `To` / `Angle` (small arrow
  rotating with it); section `Draw outline (trim)` (collapsed unless in use) with `Start %`, `End %`, `Offset %` (◆ each,
  shown as percentages, stored 0..1); when `strokeWidth` is 0 show "Only the outline is drawn — add one first" and an
  `Add outline` button (sets `strokeWidth = round(0.01 × short edge)` and a transparent fill), one undo step.

### Lane A section order in LayerProps (single layer)

1. Selected-keyframe easing (KeySelectionSection, lane B) pinned under the header — **the playhead-driven
   "Keyframe easing at Xs" section is removed** (lane B makes ◆-toggling and diamond clicks select keyframes).
2. Layer, Transform (open).
3. Type section (Typography / Shape / Image / Cursor) (open).
4. Text animation (text) / Draw outline (shapes) — collapsed unless in use.
5. Effects — collapsed unless active (`Effects ●`).
6. Animation presets (collapsed).

---

## Lane B — app, audio, UX, export, infrastructure

Owns: `src/app/**` except lane A's props files, `src/app/components/props/{AudioClipProps,KeySelectionSection,CursorPanel,ProjectSettings,common}.tsx`,
`src/render/main.ts`, `server/*`, `src/shared/audioPlan.ts`, new `src/shared/fitToFrame.ts`, `scripts/*`, `.github/*`.

### B1. Audio

- Import `.mp3 .wav .ogg .m4a .aac .flac` (byte-for-byte). Duration + waveform peaks via a low-rate
  `new OfflineAudioContext(1, 1, 8000).decodeAudioData` (5-min MP3: 0.8 s / 19 MB instead of 1.5 s / 115 MB). Playwright's
  Chromium cannot decode AAC (.m4a/.aac), so on decode failure fall back to a server endpoint that decodes with ffmpeg
  (sample count → duration, plus peaks); don't use ffprobe's format duration (wrong for ADTS/MP3). Preview playback of a
  format the browser can't decode shows a toast ("can't preview this format in this browser — the export will include
  it"). Update the file-input `accept`, the Import tooltip, the drop hint and the Relink `accept` to include audio.
- **New clip defaults**: `start = 0` if the file is at least as long as the project (music), else the playhead (SFX);
  `duration = min(asset − trimStart, projectDuration − start)`; if shortened to fit, `fadeOut = min(1.5, duration/4)`;
  `fadeIn 0`, `volume 1`. Toast: `Added music.mp3 at 0:00 — see the Audio rows`.
- Pure planner `src/shared/audioPlan.ts`: `planAudio(project, fromTime)` → scheduled clips with offsets/gains/fades;
  unit-tested; used by the preview engine.
- Preview engine `src/app/audio/engine.ts` (Web Audio): starts/stops with playback, restarts on loop wrap / seek / audio
  edits; the playhead clock stays `performance.now()`-based. Global `Sound` on/off toggle (UI preference, localStorage).
- Waveform peaks `src/app/audio/waveform.ts`, cached per asset, drawn for the trimmed region.
- Timeline: collapsible `Audio (n)` block, one row per clip: drag to move, left edge trims (start + trimStart move together,
  end fixed), right edge changes length (≤ asset − trimStart), click selects (clears layer selection and vice versa).
- Clip properties (AudioClipProps): `Name`, `Starts at (s)`, `Skip into file (s)` (tooltip "Jump past a silent intro"),
  `Length (s)`, `Volume %`, `Fade in (s)`, `Fade out (s)`, `Mute`, Delete.
- Click sounds: cursor clicks drawn as ● markers on the cursor layer's timeline row (absolute time); clips can be
  duplicated with Ctrl+D (at the playhead); audio assets in the Assets list get a `+ at playhead` button; the Cursor
  panel gets an optional `Click sound` asset picker that creates/updates one clip per click (one undo step).
- Export (`server/audioMix.ts` `buildAudioArgs`), **exact command verified on ffmpeg 6.1.1** (the spec's first version put
  audio 0.48 s early because adelay emits NOPTS timestamps, and could hang forever on an empty clip):
  ```
  ffmpeg -y -loglevel error -f rawvideo -pix_fmt rgba -s WxH -r FPS -i - -i clip0 -i clip1 …
    -filter_complex "[1:a]atrim=start=TS:duration=DUR,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=V[,afade=t=in:st=0:d=FI][,afade=t=out:st=OS:d=FO],adelay=START_MS:all=1[c0];…;
                     [c0][c1]…amix=inputs=n:normalize=0:duration=longest,asetpts=N/SR/TB,apad=whole_len=NS,atrim=end_sample=NS[aout]"
    -map 0:v -map "[aout]" <existing -vf / libx264 args> -c:a aac -b:a 192k -ar 48000 -movflags +faststart out.mp4
  ```
  with `NS = round(frameCount/fps · 48000)` (the **video** length, not durationSec).
  - Skip a clip when muted, volume = 0, `start ≥ frameCount/fps`, its asset file is missing, or `trimStart ≥ asset.duration − 1e-3`.
  - `DUR = min(duration, asset.duration − trimStart, frameCount/fps − start)`; `FI = min(fadeIn, DUR)`, `FO = min(fadeOut, DUR)`;
    emit an afade only when its value > 0 (`d=0` is NOT "no fade" — it defaults to 44100 samples); `OS = max(0, DUR − FO)`.
    `planAudio` applies the same clamping so preview == export.
  - No audible clips → no audio stream. Missing audio files are skipped with a warning on the job, shown in the dialog.
  - Exporter watchdog: after `stdin.end()`, if ffmpeg hasn't exited within 30 s, SIGKILL it and fail the job (SIGTERM is
    ignored in the hang case).
  - Tests: a `buildAudioArgs` table test (clip at 0, clip after the end → skipped, trimStart ≥ duration → skipped, fade >
    length → clamped, zero fades → no afade, single clip, non-integer durationSec·fps → pad uses frameCount/fps) plus a real
    export asserting audio `start_time = 0`, audio duration == video duration, and RMS windows matching clip placement,
    trim and fades. CLI the same.

### B2. Timeline & preview UX

- **Keyframe selection**: `store.selectedKeys` (keyframe ids). Clicking a diamond (or adding one with ◆ in Properties)
  selects it; Shift adds. KeySelectionSection (pinned under the layer header) shows `Keyframe easing (n selected)` with
  the easing picker (`data-testid="kf-easing"`) and a Delete button. Selection is cleared/filtered after undo/redo.
- Per-property keyframe rows: ▸ toggle on a layer row expands one row per animated property, labelled like Properties
  (`X`, `Shadow blur`, `Trim end`); dragging a diamond there moves only that keyframe.
- **Keyboard precedence**: Delete/Backspace → selected keyframes, else selected audio clips, else selected layers.
  Esc → clears keyframe selection first, then clips/layers. Ctrl+C/Ctrl+V → keyframes if any are selected, else layers
  (layers paste into the selected scene at the same scene-relative timing, via deepCloneLayer). Ctrl+D → layers or clips.
- **Keyframe paste** onto every selected layer: x/y values are offset so the first pasted key equals the target's
  current value at the playhead (relative motion); other properties as-is; properties not animatable on the target are
  skipped with a toast (`Pasted 6 keyframes (2 skipped: not available on text)`); Ctrl+Shift+V pastes absolute values.
- **Snapping** (preview move gesture): selection bounds (left/centre/right, top/middle/bottom) snap to the frame edges and
  centre, other visible layers' bounds, and (when guides are on) the safe-box edges, within 8 screen px; magenta guide
  lines while snapped; hold Ctrl/⌘ to drag freely. Pure maths in `src/app/snapping.ts`, unit-tested.
  **Timeline snapping**: bar/clip/scene edges and keyframes snap to the playhead, project start/end, scene boundaries,
  other bars' edges, keyframes and cursor clicks within 8 px (Ctrl disables).
- **Guides** overlay: centre lines, rule of thirds, and one safe box — for 9:16 a `Reels/TikTok UI` box (top 14%, bottom
  35%, sides 6%), otherwise a 90% title-safe box.
- Toggles live in the playback bar after Loop: `Snap` (ON by default; tooltip "Snap to edges, centre and other layers
  (hold Ctrl/⌘ to drag freely)"), `Guides`, `🔊/🔇 Sound`, `PNG` (B3). Persist the toggles in localStorage.
- Marquee selection on empty preview space (Shift adds).
- Timeline space: draggable splitter between editor and timeline (default 240 px, min 160, max 60% of the window,
  localStorage), Scenes row sticky under the ruler.
- Menus: a shared menu hook/component that closes on outside pointerdown and Escape, used by `+ Shape ▾`, `More ▾` and a
  new `File ▾` menu holding Export .zip / Import .zip (recovers toolbar width).

### B3. Export options, PNG still, multi-format copy, Windows, CI

- Export dialog: `Size` with live pixel sizes (`100% — 3840×2160`, `50% — 1920×1080 (Full HD)`, `25% — 960×540 (quick
  check)`), `Quality` (`Best (larger file)` CRF 16 / `Good` CRF 20 / `Draft (fastest)` CRF 26 + `veryfast`),
  `Include audio` (checked when clips exist; disabled with "No audio clips" otherwise). Remember choices in localStorage.
  Output name `${name}-${W}x${H}-${stamp}.mp4`. CLI flags `--scale`, `--crf`, `--no-audio`. Options validated with zod.
  Scaled size: compute `outW/outH` once (even-rounded `W·s`, `H·s`), render with `scale = max(outW/W, outH/H)` (≤ 1 px crop,
  never an unpainted edge), and carry `outW/outH` on the job for `acceptFrame`'s byte check and ffmpeg's `-s`.
- `PNG` button: current frame at full project resolution via renderFrame in the editor on a `createRenderCanvas` canvas
  (same text AA as the export), named `${name}-${W}x${H}-frame${n}.png`.
- **Make a copy in another format**: `src/shared/fitToFrame.ts` `fitToFrame(project, W2, H2)`: `k = min(W2/W, H2/H)`,
  `x' = W2/2 + k·(x − W/2)` (same for y) for layer x/y, their keyframe values and cursor points; layer `scale ×k`
  (and scale keyframes); effects follow via the layer-scale factor. Project settings → `Make a copy in another format…`
  → choose 9:16 / 1:1 / 4:5 / 16:9 → the copy opens via Save-as prefilled `<name> 9x16`. Unit test: frame centre maps to
  the new centre, all layer bounds stay inside the frame.
- Windows: tests spawn tsx through `process.execPath` (foundation did export.spec), `sanitizeName` rejects reserved names
  (CON, PRN, AUX, NUL, COM1–9, LPT1–9) and trailing dots/spaces, Vite watch-ignore paths use forward slashes.
- GitHub Actions `ci.yml`: matrix `ubuntu-latest` + `windows-latest`, Node 22, ffmpeg per OS, `npm ci`, Playwright
  Chromium (ubuntu with deps), typecheck, unit, e2e, upload test-results on failure.

---

## Explicitly still out of scope

Video clips as layers, AI generation, cloud sync (kept in the UI's "Not available" list). Multi-layer effect editing is a
nice-to-have only if time allows.

## Testing contract per feature

- A1: unit (recording ctx / injected canvases) for partner selection, effect state incl. layer-scale factor, background,
  dissolve endpoints; Playwright: export-vs-renderFrame pixel match inside a transition window and with blur/shadow/blend
  layers; determinism; UI test for the transition section + preview button.
- A2: unit for units/ranks/timing (in + out semantics), styles table, "fully revealed = identical draw calls";
  export match mid-animation; UI test applying a style.
- A3: unit for path lengths (vs numeric integration), dash/offset maths, ellipse start at 12 o'clock, gradient endpoints,
  draw-on preset; export match with trim + star + gradient; UI test for Add outline + trim fields.
- B1: unit for `planAudio`, `buildAudioArgs`, clip defaults; Playwright: import WAV via UI → row + waveform + properties;
  export with audio → AAC stream, silence/signal RMS windows match placement, trim and fades.
- B2: unit for snapping maths; Playwright for keyframe selection/delete/paste (incl. relative x/y), keyboard precedence
  (select a diamond + Delete keeps the layer), keyframe rows, snapping to exact centre, Ctrl disables, guides, marquee,
  timeline snapping, menus closing on outside click/Escape.
- B3: Playwright for scaled export dimensions + quality + CLI flags + PNG still + format copy; unit for `sanitizeName`
  and `fitToFrame`.
