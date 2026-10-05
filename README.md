# Motion Studio

A local motion-design editor that runs in your browser and saves to your own disk. You build animations from scenes, layers and keyframes, then export an H.264 MP4. It needs no account, makes no AI/API calls, and edits, plays back and saves fully offline.

> **v2 in progress** on this branch: effects, scene transitions, text animation, new shapes, audio, snapping/guides and
> export options are being added (see [docs/v2-plan.md](docs/v2-plan.md)). Until that work lands, this README describes
> what is implemented and tested today.

The deliverable is the **editor itself**. It opens on an empty project and never creates demo content, and it renders video only when you click **Export MP4** (or run the CLI).

---

## Install

You need **Node.js 20+** (tested with 22), **ffmpeg** on your PATH, and a desktop browser (Chrome or Edge recommended).

### Windows 11, step by step

1. Install Node.js LTS: `winget install OpenJS.NodeJS.LTS` (or download it from nodejs.org).
2. Install ffmpeg: `winget install --id Gyan.FFmpeg`.
3. **Close and reopen** your terminal so the new PATH is picked up.
4. Check both tools: `node -v` should print v20 or higher, and `ffmpeg -version` should print a version banner.
5. In the project folder, run `npm install`. This also downloads the headless Chromium build that export uses (about 150 MB, one time).
6. Run `npm run dev`.
7. Open **http://127.0.0.1:5173** in Chrome or Edge.

### macOS / Linux

```bash
brew install ffmpeg        # or: sudo apt install ffmpeg
npm install
npm run dev                # → http://127.0.0.1:5173
```

If the Chromium download in step 5 fails (corporate proxy, offline machine), run `npx playwright install chromium` later. Editing works without it; only export needs it.

Projects are saved in `./workspace/` by default. Set `MOTION_WORKSPACE=<folder>` to use a different location.

---

## Editing basics

| Area | What it does |
|---|---|
| **Toolbar** | New / Open / Save / Save as, Export & Import `.zip`, Undo / Redo, add Scene / Text / Rect / **Shape ▾** (rectangle, ellipse, triangle, star, polygon, line) / Cursor, Import asset, **Export MP4**. "More ▾" lists features that are *not available* yet. |
| **Left panel** | **Scenes**: add, rename (double-click), reorder ↑↓, duplicate ⧉, delete ✕. **Layers** of the selected scene, top = front: show/hide, lock, reorder, rename, duplicate, delete. **Assets**: missing files show a **Relink…** button. |
| **Preview** | Click to select, Shift-click to add to the selection, and drag to move (hold Shift to lock to one axis). Corner handles scale, and the round handle above rotates (Shift snaps to 15°). Cursor layers show their path, and you drag the numbered points to move them. Drop image or font files here to import them. |
| **Properties** (right) | Transform, opacity, typography, alignment, spacing and colour. The **◆** next to a property adds or removes a keyframe at the playhead. When the playhead is on a keyframe, an **easing picker** appears with a live curve and a plain-language description. **Animation presets** (fade, slide or scale; in or out) and **Stagger** (when several layers are selected) also live here. With nothing selected, this panel shows **Project settings**: duration, aspect ratio (16:9, 9:16, 1:1, 4:5, custom), resolution, fps and background. Every control has a tooltip. |
| **Timeline** | Click or drag the ruler to scrub. Drag scene blocks to move them, and drag their edges to resize. Drag layer bars to move them in time, and drag their edges to trim. Drag the ◆ diamonds to retime keyframes. Zoom with the slider or Ctrl + mouse wheel. |
| **Playback bar** | Play/pause, frame step, replay, loop, timecode and frame counter. |

**How keyframes behave:** once a property has at least one keyframe, any change to it (typing a value or dragging in the preview) writes a keyframe at the playhead. Properties with no keyframes just change their fixed value.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → (Shift = 10 frames) | Step one frame |
| Home | Jump to start |
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo. Each edit is one step, and one whole drag is one step |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Ctrl+D | Duplicate the selected layers |
| Delete | Delete the selected layers |
| Esc | Clear the selection |

---

## Save / Open

- **Save** writes a folder `workspace/<name>.motion/` that contains `project.json` (schema-validated with zod) and `assets/`.
- **Imported files are copied byte-for-byte**, named `<sha256 prefix>-<original name>`, and never re-encoded.
- **Unsaved changes** show a ● next to the project name and in the browser tab title. The browser warns you if you close the tab with unsaved changes.
- **Missing files** (deleted or moved assets) show as a grey crossed placeholder in the preview, plus a **Relink…** button. Relinking keeps every layer that uses the file.
- **Export .zip / Import .zip** packs or unpacks the whole project (`project.json` plus assets) as a single file.

---

## Export

**From the app:** click **Export MP4**, then **Start export**. A progress bar and a **Cancel** button appear while it runs. When it finishes, the file is saved to `workspace/exports/` and offered as a download.

**From a terminal** (the same pipeline, with no editor UI):

```bash
npm run render -- "workspace/My project.motion" out.mp4
```

### How export works

- The server launches headless Chromium (Playwright) on a render-only page (`render.html`). That page waits for `document.fonts.ready` and for every image to decode before frame 0.
- It then calls the same `renderFrame()` the editor uses for every frame, at the full project resolution.
- Raw RGBA frames stream into `ffmpeg -c:v libx264 -crf 16 -pix_fmt yuv420p -movflags +faststart`, tagged BT.709, with accurate-rounding colour conversion.
- **If ffmpeg is missing**, the export dialog (and the CLI) shows the install command for your OS and the exact CLI command to render your saved project afterwards.

**Measured speed** (4-core Linux container): a 3 s 1080p clip renders in about 6 s, and a 15 s 4K clip (450 frames) in about 64 s.

---

## Architecture

```
src/shared/schema.ts        zod schema = single source of truth for project.json
src/shared/renderFrame.ts   renderFrame(project, timeSec, ctx, scale, resources) — pure Canvas 2D drawing
src/shared/easing.ts        linear / ease-in / ease-out / ease-in-out / cubic-bezier / spring (closed form)
src/shared/interpolate.ts   keyframe sampling, colour interpolation
src/shared/presets.ts       animation presets → ordinary keyframes; stagger (seeded PRNG)
src/app/                    React editor (Zustand store with immer; undo/redo via snapshots + gestures)
src/render/main.ts          render-only page used by export (and tests)
server/                     Express: projects, assets, zip, export jobs; Vite dev middleware on the same port
```

- **Deterministic rendering:** output depends only on `(project, time)`. There is no `Date.now()`, no unseeded `Math.random()`, no CSS animation and no state that builds up across frames, so any timestamp can be rendered directly. Springs are evaluated in closed form, and "random" stagger uses a seeded PRNG.
- **Crisp at 4K:** the preview canvas is sized in device pixels (devicePixelRatio-aware). Export draws vectors at the full target resolution, and a bitmap of the canvas is never upscaled. Imported bitmaps are placed at no more than their natural size by default.

### Deviations from the original brief's stack (and why)

- **One process instead of two:** Express mounts Vite in middleware mode, so the API, the editor and the export page share one origin and port. That means no CORS setup and nothing extra to start. `npm run dev` is still the only command.
- **Immer** for immutable edits: it makes snapshot-based undo cheap and keeps each edit to a few lines.
- **Inter** (via `@fontsource/inter`) is bundled so the preview and export use the same font offline.

---

## Works (tested)

Everything in this section has a passing automated test. Run `npm test` for 39 unit tests plus 15 Playwright end-to-end tests. They also passed 3 full repeats in a row (45/45).

**Unit (`tests/unit`)**
- Interpolation: hold before the first and after the last keyframe, linear interpolation, per-segment easing, unsorted keys, colour and alpha interpolation, falling back to the fixed value.
- Every easing type ends exactly at 0 and 1 and is deterministic. Ease-in/out shapes, CSS cubic-bezier reference values and overshoot are checked. Springs: underdamped, critical and overdamped, plus independence from segment length.
- Determinism: `renderFrame` gives identical draw calls when rendered twice, and the order frames are rendered in doesn't matter. Hidden and out-of-range layers are skipped, and the cursor reaches each target point.
- Presets: fade, slide and scale generate keyframes, and re-applying replaces the previous preset while keeping manual keyframes. Stagger forward, reverse and seeded-random orders are repeatable.

**End-to-end (`tests/e2e`)**
- **The brief's full flow:** new project → import fixture image → place it by dragging → keyframes on x and opacity → move the second keyframe in time → scrub to the midpoint and screenshot → undo (the value reverts) → redo → save → reload the app → open the project. The test then deep-compares `project.json` (scenes, layers, keyframes, settings, asset refs), confirms the asset is byte-identical and loads, and checks that one drag counts as one history step.
- **The brief's export test:** a 3 s 1080p project goes to MP4, and ffmpeg extracts the first, middle and last frames. Each is compared with `renderFrame` output at the same timestamp: mean absolute difference about 0.78 out of 255, PSNR about 38.8 dB (thresholds: 1.5 and 36 dB). The MP4 is H.264, yuv420p, 90 frames at 30 fps, with faststart.
- **Pixel determinism** in real Chromium: the same `t` twice gives an identical SHA-256.
- **CLI render** works, and a missing ffmpeg gives a clear error with install steps. **Export can be cancelled.**
- **Export MP4 dialog:** the progress bar reaches 30/30 and the download works.
- **Zip export and import** round-trip.
- **Missing asset:** placeholder plus **Relink…** restores it.
- **Settings:** changing aspect, duration or fps never deletes layers, and each change is one undo step.
- **Presets UI:** the slide preset generates keyframes and re-applying doesn't duplicate them. **Stagger UI** applies 0.5 s offsets.
- **Preview handles:** scale, rotate with Shift snapping to 15°, Shift-constrained move. Each drag is one undo step. Selection stays synced across the preview, the layers list and the timeline, and clicking empty space deselects.
- **Scenes:** create, rename, duplicate, reorder, delete. **Layers:** reorder, hide, lock, rename, duplicate, delete, undo.
- **Timeline:** drag a scene edge, move and trim layer bars, zoom.
- **Playback:** Space plays and pauses, arrow keys step frames, playback stops at the end, loop wraps, and the timecode and frame counter update.
- **Imports:** SVG and font import. The font appears in the Font menu, and spring easing set through the easing picker is stored on the keyframe.
- **Cursor layer:** drag a path point in the preview, add a click at the playhead, change smoothing.

## Not implemented

- Video clips as layers, AI generation, and cloud sync. These are listed as **"Not available"** under the toolbar's "More ▾" menu. (Audio, scene transitions and effects are being built in v2.)
- Marquee (box) selection, snapping and guides, and per-property keyframe rows in the timeline. Diamonds are grouped per layer, and dragging one moves every property's keyframe at that time.
- Animating the anchor point (it is a fixed value). Triangle, star, polygon and line can be added but currently draw as rectangles until the v2 shape work lands.

## Known limitations

- **Developed and tested on Linux** (Node 22, Chromium 141 via Playwright 1.56.1). The code avoids OS-specific paths and commands, but **it has not yet been run on Windows 11**. Please report anything that breaks there.
- **Preview vs export:** the preview draws in *your* browser, while export uses headless Chromium. In Chrome or Edge they match. In Firefox or Safari, text anti-aliasing may differ slightly.
- **Export speed:** rendering is CPU-only, so expect roughly 1 minute per 15 s of 4K on a 4-core machine.
- **Undo history** lives in memory only and resets when you open a project.
- **Test hook:** the editor exposes its state store on `window.__motion` (read by the end-to-end tests).

---

## Development

```bash
npm run typecheck
npm run test:unit      # vitest
npm run test:e2e       # Playwright (starts its own server on port 5199, workspace .e2e-workspace/)
```
