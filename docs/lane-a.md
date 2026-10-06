# Lane A — rendering engine (docs/v2-plan.md, Lane A)

Status per feature, the user-facing behaviour in plain language, the exact tests that cover it, and measured numbers.
Numbers were measured in this container (headless Chromium 141 with `--disable-gpu`, ffmpeg 6.1.1, 4 shared cores).

## A1 — Layer effects, scene background, scene transitions — DONE

### What the user gets

**Effects** (Properties → *Effects*, for every layer type, collapsed until an effect is used; the heading then reads
`Effects ●` and the section opens when the layer is selected):

- **Blur** (◆ animatable) — softens the whole layer.
- **☐ Drop shadow** — the first tick on a layer with no shadow values fills in a soft default sized for the frame
  (colour `#00000040`, offset Y = 0.75 % of the short edge, softness = 2.2 % of the short edge: 16 / 48 px at 4K,
  8 / 24 px at 1080p), all in one undo step. Rows *Colour*, *Softness*, *Offset X/Y* (each ◆) appear while it is on.
  Unticking hides them and keeps the values; ticking again restores them.
- **Blend** — `Normal`, then grouped modes: Darken (Multiply, Darken, Colour burn), Lighten (Screen, Lighten, Colour
  dodge), Contrast (Overlay, Soft light, Hard light), Difference (Difference, Exclusion), Colour (Hue, Saturation,
  Colour, Luminosity). Tooltip: "How this layer mixes with what's behind it. Multiply darkens, Screen lightens."
- Effects grow and shrink with the layer: blur, shadow softness and shadow offset are multiplied by the layer's own
  scale (and the render scale), like CSS / After Effects. Shadow offsets stay screen-space (rotating a layer doesn't
  turn its shadow).
- Layers drawn with several strokes (an outlined shape, multi-line text, the cursor, a missing-image placeholder) get
  their shadow/blur/blend applied to the layer as a whole: an outline never casts a shadow onto its own fill, and the
  cursor's shadow never darkens its own arrow.
- Animated values that overshoot (spring/custom curves) are clamped: blur, shadow softness and outline width never go
  below 0, opacity stays within 0–1.
- New cursors keep their subtle default shadow, and it is visible from the first frame.

**Scene background** (Scene properties → *Background*): `☐ Own background colour` reveals a colour picker that starts
from the project background; the colour fills the whole frame behind that scene's layers. One undo step per change.

**Transitions** (Scene properties → *Transition into this scene*):

- `Style`: None (cut) / Cross-fade / Slide over / Push / Wipe / Zoom / Blur.
- `Length (s)` — "Plays during the first N s of this scene. The previous scene holds its last frame unless they
  overlap." A length longer than the scene is shortened to the scene (a hint says so).
- `Direction` (Slide over / Push / Wipe only), named by the direction of travel: `← Right to left`, `→ Left to right`,
  `↑ Bottom to top`, `↓ Top to bottom` (← means the new scene enters from the right edge).
- Easing picker (same as keyframes), `From: <scene>` / `From: background (no scene before)`.
- `▶ Preview` plays from 0.5 s before to 0.5 s after the transition and stops.
- `Apply to all scenes` copies style, length, direction and easing to every scene except the one that starts first, in
  one undo step.
- The timeline shows a hatched strip at the start of the scene; hovering it shows `Cross-fade from Hook · 0.6 s`
  (the foundation CSS had `pointer-events: none` on the strip, so the tooltip never appeared; `styles-engine.css`
  re-enables it — presses on the strip still drag the scene and the edge handles stay on top).
- Which scene it transitions from: the scene that **ends inside the transition** (between the new scene's start and
  start + length; latest end wins, ties go to the later one in the list). That scene holds its last frame if it has
  already ended. A scene that keeps running past the transition (e.g. a logo overlay over the whole video) is never
  the one transitioned from — it keeps drawing normally. With no such scene, the new scene transitions in over whatever
  is underneath (e.g. fades in from the background). A scene is used by at most one transition at a time.
- Looks: Cross-fade is an exact cross-fade (no dark dip in the middle). Slide over / Push / Wipe move the scenes as
  vectors (text stays sharp) with a whole-pixel seam. Zoom: the new scene settles from 125 % to 100 % while fading in.
  Blur: the old scene blurs out while the new one un-blurs (up to 3 % of the frame's long edge); the frame edges blur
  into the scene's background colour instead of going transparent. Blend modes look the same inside a transition as
  after it.

**Animation presets**: the Slide direction uses the same arrow labels.

### Tests

Unit (vitest):

- `tests/unit/engine-effects.test.ts` › effect values: *blur, shadow blur and shadow offsets scale with k = render scale
  × |layer scale|*; *shadow offsets stay screen-space*; *a shadow is drawn only when switched on and its colour is
  visible*; *blend modes map to globalCompositeOperation*; *clamps overshooting animated values before they reach the
  canvas*; *margins*; *drop-shadow defaults are sized from the short edge of the frame*.
- `tests/unit/engine-effects.test.ts` › effect drawing: *single-draw layer: … a filtered draw is clipped to ink ⊕
  3·radius*; *multi-draw layers are isolated: drawn plainly into a scratch canvas, composited once with the effect*;
  *single-draw layers keep the direct path; multi-draw ones are isolated only when an effect is active*; *the cursor
  scratch canvas sits at the pointer (cursorPosition), not at the layer box*; *opacity is applied once, at the
  composite*; *every filtered draw is clipped, and scratch canvases are released once per frame*; *without a pool,
  scratch canvases come from resources.createCanvas*; *an isolated layer that cannot reach the frame is skipped; a
  shadow cast into the frame is still drawn*; *the effect factor uses the scale it is given*; *is deterministic, also
  through scratch canvases*.
- `tests/unit/engine-inkbounds.test.ts` › *inkBounds contains everything drawLayer paints* (12 layer setups × 3 render
  scales × 6 times: multi-line/rotated/mirrored text, outlined rects with round and miter corners, ellipses, missing and
  loaded images, the cursor incl. click ripples and mirrored scale; every painted point replayed through the transform
  stack must be inside) and *inkBounds is tight enough to be useful* (exact box for an outlined rect, scale, cursor at
  `cursorPosition` not at the layer box, ripple growth, text animator margins, empty text).
- `tests/unit/engine-v1-compat.test.ts` › *a project without effects, backgrounds or transitions draws exactly the v1
  calls* — the full draw-call log recorded with the v1 renderer before A1 (every layer type, keyframes, two scenes).
- `tests/unit/engine-transitions.test.ts` › scene background; transition plan at render time (*sequential scenes …*,
  *a long overlay scene running past the window is not a partner*, *a gap before the scene*, *a scene is the partner of
  one transition only*, *a scene drawn as a partner does not run its own transition*, *progress is clamped to 0..1 even
  when a spring overshoots*); *slide left / push right / wipe up* clip + translate sequences with no offscreens;
  *directional layout*; fade (*O′ and I′ start as copies of the frame so far, then the dissolve …*), *dissolve
  endpoints*, zoom (*vector scale 1.25 → 1 about the frame centre*), blur (*padded canvases filled with the scene colour,
  blurred, then cropped back out*), *layer effects inside a transition use the zoomed scale and stay clipped*, *releases
  pooled canvases once per frame and is deterministic*.
- Existing `tests/unit/transitions.test.ts` (foundation) covers the partner rule itself (sequential, overlapping, gap,
  long overlay scene, tie).

Playwright (real Chromium):

- `tests/e2e/engine-effects.spec.ts` › *a stroked rect with a drop shadow keeps its fill colour*; *the default cursor
  (drop shadow on) is visible at t = 0 and t = 1 s*; *export matches renderFrame for stroked, shadowed, blended and
  blurred layers*; *4K performance guard: 3 blurred layers + a 12-word "Blur in" text render in < 400 ms*;
  *renderFrame stays deterministic with isolated effect layers and transitions, also when frames are interleaved*;
  *Effects section: collapsed until used, drop-shadow defaults in one undo step, grouped blend modes*; *slide preset
  direction uses the same arrow labels as transitions*.
- `tests/e2e/engine-transitions.spec.ts` › *export matches renderFrame inside a cross-fade / slide / wipe / zoom / blur
  window* (one test each); *dissolve endpoints: p → 0 is the outgoing image alone, p → 1 the incoming one alone (within
  1/255)*; *a blend-mode layer inside a fade window matches the same layer just after the window*; *Transition into
  this scene: style, length, direction, From line, preview, apply to all, strip tooltip, background* (also: the strip
  can be hovered and dragging it moves the scene as one undo step).

### Measured

- **4K effects performance** (3 blurred 700×420 layers, one outlined + shadowed, one screen-blended, + a 12-word text
  layer): `window.motion.render` (incl. PNG encoding + hashing) 261–289 ms, `renderFrame` alone ≈ 50 ms. With the
  filter clips disabled the same frame took ≈ 1000 ms (`renderFrame` ≈ 790 ms) — the guard asserts the best of three
  renders is < 400 ms.
- **Export vs renderFrame** (1920×1080, CRF 16, yuv420p; thresholds mean |diff| < 1.5, PSNR > 36 dB):
  effects 0.33–0.38 / 40.4–40.6 dB; inside the transition window — cross-fade 0.49–0.63 / 41.8–47.5 dB, slide
  0.31–0.74 / 40.3–41.9 dB, wipe 0.30–0.64 / 41.7–46.5 dB, zoom 0.49–0.60 / 42.0–47.7 dB, blur 0.39–0.59 /
  49.4–50.7 dB. (At 960×540 the same scenes measured ~36–37 dB because 4:2:0 chroma loss at sharp colour edges weighs
  more, so the export tests use 1080p.)
- **Dissolve endpoints**: p = 0 and p = 1 identical to the outgoing / incoming image (max diff 0); p = 0.001 / 0.999
  within 1/255; two white images stay 255 at p = 0.5 (no dip). A multiply layer at p ≈ 0.998 differs from the first
  frame after the window by ≤ 2 levels.
- **Transition cost at 1080p** (`window.motion.render`, incl. PNG): plain ≈ 67 ms, slide/push/wipe ≈ 70 ms, fade
  ≈ 105 ms, zoom ≈ 137 ms, blur ≈ 233 ms.

### Implementation notes (for the lead, A2 and A3)

- Modules: `src/shared/geometry.ts` (text metrics, layer box/matrix, cursor motion, device `Box` helpers — moved out of
  renderFrame.ts, which re-exports the old names), `src/shared/effects.ts` (`clampResolved`, `layerEffects` with k,
  `effectRegion`/`influenceRegion`, `shadowDefaults`), `src/shared/inkBounds.ts`, `src/shared/transitionDraw.ts`
  (`directionalLayout`, `dissolve`, `blurPad`, `zoomFactor`), `transitions.ts` + `planTransitions`.
- `drawLayer(ctx, layer, local, res, scale, ox = 0, oy = 0)`: (ox, oy) is where the project origin sits on the canvas
  (non-zero while slide/push move a scene); the context's transform must equal that mapping.
- `RenderResources.createCanvas(w, h)` is the canvas factory hook used when no `canvasPool` is given (unit tests inject
  recording canvases); the order is pool → createCanvas → `createRenderCanvas`. `releaseAll()` runs in a `finally`.
- Isolation applies only when an effect is active and the layer is multi-draw (`isMultiDraw` in renderFrame.ts). A2:
  add "an active text animator" there and give each unit's own blur its own clip (`effectRegion` of the unit's ink).
  A3: new shapes with acute corners are already covered by `inkBounds` (× miterLimit); text outline width is already in
  the text ink box and in `isMultiDraw`.
- Scratch canvases are sized to the visible part of the layer plus its effect margin, rounded up to 64 px so the pool
  reuses them while a layer moves; blur-transition pads are rounded up to 32 px. Both are pure functions of the frame,
  so pooling never changes the output.
- Clip regions of filtered draws also include the shadow (offset + softness), otherwise a large shadow offset would be
  cut off; for shadows without a filter no clip is needed.
