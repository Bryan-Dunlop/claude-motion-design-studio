# Motion Studio

A local motion-design editor that runs in your browser and saves to your own disk. You build short videos from
scenes, layers and keyframes, add sound, and export an H.264 MP4. There is no account and no AI/API calls; editing,
playback and saving work fully offline.

The deliverable is the **editor itself**. It opens on an empty project, never creates demo content, and renders video
only when you click **Export MP4** (or run the CLI).

---

## Install

You need **Node.js 20+** (tested with 22), **ffmpeg** on your PATH, and a desktop browser (Chrome or Edge recommended).

### Windows 11, step by step

1. Install Node.js LTS: `winget install OpenJS.NodeJS.LTS` (or download it from nodejs.org).
2. Install ffmpeg: `winget install --id Gyan.FFmpeg`.
3. **Close and reopen** your terminal so the new PATH is picked up.
4. Check both: `node -v` should print v20 or higher, and `ffmpeg -version` should print a version banner.
5. In the project folder, run `npm install`. This also downloads the headless Chromium build that export uses
   (about 150 MB, one time).
6. Run `npm run dev`.
7. Open **http://127.0.0.1:5173** in Chrome or Edge.

### macOS / Linux

```bash
brew install ffmpeg        # or: sudo apt install ffmpeg
npm install
npm run dev                # → http://127.0.0.1:5173
```

If the Chromium download fails (corporate proxy, offline machine), run `npx playwright install chromium` later.
Editing works without it; only export needs it.

Projects are saved in `./workspace/` by default. Set `MOTION_WORKSPACE=<folder>` to use a different location.

---

## What you can make

| | |
|---|---|
| **Layers** | Text, images (PNG, JPG, WebP, SVG), shapes (rectangle, ellipse, triangle, star, polygon, line) and an animated mouse **cursor** with click ripples. |
| **Animation** | Keyframes on any animatable property, with easing (steady, speed up, slow down, smooth, custom curve, spring) and a live curve preview. **Presets**: fade, slide, scale and *Draw on* (an outline drawing itself), in or out. **Stagger** for several layers. |
| **Text animation** | One-click styles — *Words rise*, *Letters fade*, *Typewriter* (with caret), *Lines slide up*, *Blur in*, *Words fade out*, *Backspace* — or customise by letter / word / line, effect, order, timing and easing. Kerning stays exact. |
| **Scenes & transitions** | Scenes follow each other on the timeline. *Transition into this scene*: cross-fade, slide over, push, wipe, zoom or blur, with direction, length and easing, a ▶ Preview button and *Apply to all scenes*. Each scene can have its own background colour. |
| **Look** | Blur, drop shadow and blend modes on any layer; solid or gradient fills for shapes and text; outlines; *trim paths* (show part of an outline, animate it to draw on). Effects scale with the layer. |
| **Sound** | Music and sound effects (MP3, WAV, OGG, M4A, AAC, FLAC) on audio rows with waveforms, trims, volume and fades; a *Click sound* that plays at every cursor click and follows the clicks. |
| **Layout help** | Snapping to the frame, other layers and safe areas (magenta guides; hold Ctrl/⌘ to move freely), a Guides overlay with a Reels/TikTok safe zone for 9:16, marquee selection. |
| **Formats** | 16:9, 9:16, 1:1, 4:5 or custom, up to 4K. *Make a copy in another format…* turns a 16:9 project into a 9:16 (or 1:1 / 4:5) copy with everything scaled to fit. |
| **Export** | MP4 at 100 / 50 / 25 % size, three quality levels, with or without sound; a PNG of the current frame; the same render from a terminal. |

---

## Editing basics

| Area | What it does |
|---|---|
| **Toolbar** | New / Open / Save / Save as, **File ▾** (Export .zip / Import .zip), Undo / Redo, add Scene / Text / Rect / **Shape ▾** / Cursor, Import asset, **Export MP4**. "More ▾" lists features that are *not available* yet. |
| **Left panel** | **Scenes** (add, rename by double-click, reorder, duplicate, delete). **Layers** of the selected scene, top = front (show/hide, lock, reorder, rename, duplicate, delete). **Assets** (images, fonts, sounds; sounds have *+ at playhead*; missing files show **Relink…**). |
| **Preview** | Click to select, Shift-click to add, drag on empty space for a marquee. Drag to move (snaps; hold Shift to lock to one axis, Ctrl/⌘ to move freely), corner handles scale, the round handle rotates (Shift snaps to 15°). Cursor layers show their path with draggable points. Drop image, font or sound files here to import them. |
| **Properties** (right) | Everything about the selection, in plain language with a tooltip on every control. **◆** next to a property adds/removes a keyframe at the playhead. Selected keyframes show their easing at the top. Sections for typography or shape, text animation, outline (trim), effects and presets open when they're in use. With nothing selected: scene settings (background, transition) and **Project settings** (duration, aspect, resolution, fps, background, *Make a copy in another format…*). |
| **Timeline** | Ruler (click/drag to scrub), scene blocks (drag to move, edges to resize; hatched strip = transition), layer bars (move, trim), keyframe diamonds (click to select, drag to retime; ▸ expands one row per property), the **Audio** block (clips with waveforms: move, trim either end) and ● cursor-click markers. Drags snap to the playhead, scene edges, other bars, keyframes and clicks. Drag the divider above it to resize; zoom with the slider or Ctrl + wheel. |
| **Playback bar** | Play/pause, frame step, replay, loop, timecode and frame counter, **Snap**, **Guides**, **🔊 Sound** (preview only) and **PNG** (save this frame). |

**How keyframes behave:** once a property has a keyframe, any change to it (typing or dragging in the preview) writes
a keyframe at the playhead. Properties without keyframes just change their value.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → (Shift = 10 frames) | Step one frame |
| Home | Jump to start |
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo — each edit is one step, a whole drag is one step |
| Delete / Backspace | Delete the selected keyframes, else the selected sound clips, else the selected layers |
| Ctrl+C / Ctrl+V | Copy / paste keyframes (positions are pasted *relative* to each selected layer) or layers |
| Ctrl+Shift+V | Paste keyframes with their exact values |
| Ctrl+D | Duplicate the selected layers or sound clips |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Esc | Clear the keyframe selection, then the clip/layer selection |

---

## Save / Open

- **Save** writes a folder `workspace/<name>.motion/` with `project.json` (validated with zod) and `assets/`.
  Projects made with v1 open automatically (they are upgraded on load).
- **Imported files are copied byte-for-byte** (named `<sha256 prefix>-<original name>`), never re-encoded.
- **Unsaved changes** show a ● next to the project name and in the tab title; closing the tab warns you.
- **Missing files** (moved or deleted images, fonts, sounds) show a placeholder and a **Relink…** button that keeps
  every layer and clip that uses them.
- **File ▾ → Export .zip / Import .zip** packs or unpacks a whole project (also zips made with Windows' Compress-Archive).

---

## Export

**From the app:** click **Export MP4**, pick *Size* (100 % / 50 % / 25 %, with the real pixel size shown), *Quality*
(Best / Good / Draft) and *Include audio*, then **Start export**. A progress bar and **Cancel** appear; the file goes to
`workspace/exports/<name>-<W>x<H>-<date-time>.mp4` and is offered as a download. Your choices are remembered.

**From a terminal** (same pipeline, no editor UI):

```bash
npm run render -- "workspace/My project.motion" out.mp4
npm run render -- "workspace/My project.motion" draft.mp4 --scale 0.5 --crf 26 --preset veryfast --no-audio
```

**How it works:** the server opens headless Chromium on a render-only page that waits for fonts and images, then draws
every frame with the same `renderFrame()` the editor uses and streams the pixels into ffmpeg
(`libx264`, `yuv420p`, BT.709, `+faststart`; CRF 16 / 20 / 26). Sound is mixed by ffmpeg with exactly the same timing,
trims and fades as the preview, and is exactly as long as the video. If ffmpeg is missing, the dialog and the CLI show
how to install it.

**Measured speed** (4-core Linux container): a 3 s 1080p clip exports in about 6 s; a 15 s 4K clip (450 frames) in
about 64 s. Blur and transitions cost extra while they are on screen (see `docs/lane-a.md`).

---

## Works (tested)

Everything below is covered by automated tests that pass. Run `npm test`:
**354 unit tests** (vitest) and **105 end-to-end tests** (Playwright, real Chromium + ffmpeg), all passing on Linux; CI
runs them on Ubuntu and Windows.

The exact test names and measured numbers for every v2 feature are in [`docs/lane-a.md`](docs/lane-a.md) (rendering:
effects, transitions, text animation, shapes) and [`docs/lane-b.md`](docs/lane-b.md) (sound, timeline/preview, export,
Windows, CI).

**Core editor (v1, still covered):** the brief's full flow — new project → import image → place it → keyframes on x and
opacity → move a keyframe in time → scrub → undo / redo → save → reload → open → `project.json` deep-compared and the
asset byte-identical; MP4 export compared frame-by-frame with `renderFrame` (first / middle / last frame, mean
difference < 1.5 / 255, PSNR > 36 dB); CLI render; cancel; zip round trip; missing-file relink; handles, panels,
timeline, playback, SVG/font import, cursor paths; v1 projects open in v2.

**v2:**
- **Effects & transitions** — blur, drop shadow and blend modes (an outline never shadows its own fill; the cursor's
  shadow is visible from frame 1); scene backgrounds; every transition style exported and compared with `renderFrame`
  inside the transition (PSNR ≥ 40 dB); cross-fades have no mid-point dip; the "previous scene" rule; a 4K performance
  guard (< 400 ms per heavy frame).
- **Text animation** — every style and setting, in and out timing, kerning identical to whole-line text (also for
  right-to-left lines), the caret, export compared mid-animation (PSNR ≥ 42.7 dB); text in other scripts (Polish,
  Cyrillic, Vietnamese…) is in Inter from the first frame; imported fonts with any file name.
- **Shapes** — every shape kind, outline lengths checked against numeric integration, trim paths incl. wrap-around and
  pills, gradients, text outlines (also while fading), *Draw on*, export compared (PSNR ≥ 40.8 dB).
- **Sound** — import (incl. formats the browser can't decode), clip defaults, waveform rows, move/trim/volume/fades,
  click sounds, preview engine, missing-file relink; real exports measured: sound starts at 0, is exactly as long as
  the video, and is placed, trimmed and faded where it should be.
- **Timeline & preview** — keyframe selection, rows, delete, relative copy/paste (also into another project, files
  included), keyboard precedence, snapping (exact centre/edges; Ctrl disables), guides incl. the 9:16 safe zone,
  marquee, menus closing on outside click/Esc, resizable timeline, "+ Scene" splitting the timeline; a dropped
  keyframe replaces the one it lands on; the preview shows the last frame at the end and survives a frame that fails
  to draw.
- **Editing fields** — a typed value lands on the item it was typed for (as its own undo step) whatever you click
  next; Escape cancels it; Ctrl+S saves it; undo/redo/Delete work right after picking from a dropdown or a colour.
- **Export & formats** — 100/50/25 % sizes incl. odd sizes, quality levels, include-audio, unique file names, CLI flags,
  PNG still identical to the video frame, *Make a copy in another format*, Windows-safe names, Notepad/PowerShell files.
- **When an export goes wrong** — a crashed or frozen render page, ffmpeg dying or stuck, Ctrl+C in the CLI: the export
  stops with a plain message and leaves no half-written MP4; a slow but healthy finish (slow preset, 4K) is not cut
  off; 1200 click sounds export; a mistyped project folder gets one plain line from the CLI.

## Not implemented

- Video clips as layers, AI generation, cloud sync (listed as "Not available" under "More ▾").
- Arrow-key navigation in toolbar menus; copy/paste between browser tabs (the clipboard is per tab).

## Known limitations

- **Windows**: developed on Linux; the CI workflow (`.github/workflows/ci.yml`) runs the whole suite on
  `windows-latest` as well as Ubuntu, and both pass. A few end-to-end tests fake a frozen ffmpeg or stop processes with
  POSIX tools, so they run on Linux/macOS only.
- **Preview vs export**: the preview draws in *your* browser, export in headless Chromium. In Chrome/Edge they match.
- **Export speed**: CPU-only rendering, roughly 1 minute per 15 s of 4K on 4 cores; blur transitions cost ~0.5 s per
  4K frame while they run.
- **Sound**: preview needs a click or key press first (browser rule — pressing Play is enough). Sources with more than
  two channels may sound slightly different in preview vs export. Formats the browser can't play still export.
- **Letter-by-letter animation** can't use ligatures while the letters move (the final text is exact); Arabic letters
  lose their joining while they move.
- **Right-to-left text** (Hebrew, Arabic) animates by word or letter in place. A line that mixes right-to-left and
  left-to-right words — or digits, when animating by letter — animates as one whole line.
- **Format copy** scales and centres; it doesn't re-arrange layouts for the new shape.
- **Undo history** lives in memory only and resets when you open a project.
- **Test hook:** the editor exposes its store on `window.__motion` (used by the Playwright tests).

---

## Architecture (short)

```
src/shared/schema.ts        zod schema (v2) = single source of truth for project.json; v1 files migrate on load
src/shared/renderFrame.ts   renderFrame(project, t, ctx, scale, resources) — pure Canvas 2D drawing
src/shared/…                easing, interpolation, presets, transitions (+ transitionDraw), effects, inkBounds,
                            textAnim, shapes, geometry, audioPlan, exportSize, fitToFrame, canvas (pool), names
src/app/                    React editor (Zustand + immer; undo/redo via snapshots + gestures), audio engine,
                            snapping, clipboard, timeline, preview, properties sections
src/render/main.ts          render-only page used by export (and tests)
server/                     Express: projects, assets, zip, export jobs, audio mix; Vite middleware on the same port
```

Rendering is deterministic (no clocks, no unseeded randomness, no state between frames), text and shapes are drawn as
vectors at the target size, and the preview, the PNG still and the MP4 come from the same function.

---

## Development

```bash
npm run typecheck
npm run test:unit      # vitest
npm run test:e2e       # Playwright (own server on E2E_PORT, default 5199; workspace .e2e-workspace/)
```

See `CLAUDE.md` for project rules and testing gotchas, and `docs/v2-plan.md` for the v2 design spec.
