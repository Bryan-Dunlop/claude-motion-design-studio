# Motion Studio — notes for Claude

Local motion-design editor: React editor in the browser + Express server on one port; MP4 export renders frames in
headless Chromium with the same `renderFrame()` the editor uses, piped into ffmpeg. See README.md for the user view and
docs/v2-plan.md for the current feature spec.

## Commands

```bash
npm run dev            # http://127.0.0.1:5173 with live reload (PORT, MOTION_WORKSPACE env vars)
npm start              # for users: serves the editor built into dist/ (rebuilt when src/ changes) and opens the
                       # browser; no Vite client in the page, so a server restart can't reload the editor and lose work.
                       # Start Motion Studio.cmd runs it on Windows (npm install first when needed)
npm run typecheck      # tsc --noEmit (TypeScript 7)
npm run test:unit      # vitest, tests/unit/**
npm run test:e2e       # Playwright, tests/e2e/** — starts its own server on E2E_PORT (default 5199), workspace .e2e-workspace/
npx playwright test tests/e2e/editor.spec.ts -g "name"   # one test
npm run render -- <folder.motion> <out.mp4>              # CLI export
```

Chromium for Playwright is preinstalled in cloud sessions (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); never run
`playwright install` there. ffmpeg is on PATH.

## Invariants (don't break these)

- `src/shared/schema.ts` (zod) is the single source of truth for `project.json`. Old files must keep opening:
  `ProjectSchema` migrates older `schemaVersion`s; new fields need zod defaults (function form for objects).
- `renderFrame(project, t, ctx, scale, resources)` is pure and deterministic: no `Date.now()`, no unseeded
  `Math.random()`, no state carried between frames, no CSS animation. Seeded randomness only (`seededRandom`).
  Anything in project units that becomes canvas pixels (filter blur radius, shadow blur/offset, line widths set
  outside the transform) must be multiplied by `scale`.
- Preview and export must match: the export test compares MP4 frames to `renderFrame` output pixel-wise.
- Undo: `commit(recipe)` = one history step. Drags use `startDrag` (src/app/drag.ts), which wraps
  `beginGesture`/`updateGesture`/`endGesture` so a whole drag is one step. Never call `commit` per mouse-move.
- Editing an animated property goes through `setProp` (store.ts): if the property has keyframes it writes a keyframe at
  the playhead, otherwise it changes the static value. Animatable properties are listed in `ANIMATABLE`.
- Asset bytes are stored byte-for-byte (sha256-addressed scratch store, copied into `<name>.motion/assets/` on save).
- No network/AI calls at runtime; everything works offline.

## Code map

- `src/shared/` — schema, easing, interpolation, presets/stagger, `renderFrame`, resource loading (browser only).
- `src/app/` — React editor. `store.ts` (zustand + immer, history), `actions.ts` (user operations + server calls),
  `components/` (Preview, Timeline, Properties, LayersPanel, Dialogs, Fields).
- `src/render/main.ts` — render-only page used by export (`?job=<id>`) and by tests (`window.motion.render(...)`).
- `server/` — `app.ts` (routes + Vite middleware on the same http server), `projects.ts` (workspace, zip, safe paths),
  `exporter.ts` (Chromium + ffmpeg jobs), `audioMix.ts` (ffmpeg audio graph), `render-cli.ts`, `dev.ts` (start-up,
  stop signals), `startup.ts` (default workspace `~/Motion Studio`, port messages, opening the browser, building dist/
  for `npm start`).
- `scripts/` — `postinstall.mjs` (install stamp + headless Chromium), `needs-install.mjs` (the launcher's check).
- `window.__motion.useEditor` exposes the store for Playwright tests.

## Testing conventions and gotchas (learned the hard way)

- In Playwright, click a layer row via `getByTestId('layer-item-<name>').locator('.name')` — the row centre is the lock
  button.
- Number fields re-render a frame after the store changes: read them with `expect.poll(...)`, not a one-shot
  `inputValue()` right after a scrub/undo.
- Use `startDrag`-style mouse sequences with several `mouse.move` steps; drags have a 2 px threshold.
- E2E tests must use unique project names (`Date.now()`), since `.e2e-workspace/` persists between runs.
- Express `res.sendFile`/`download` need `{ dotfiles: 'allow' }` because the scratch store is `.scratch/`.
- ffmpeg writes `<out>.mp4.part`; the exporter renames it when the video is complete. A test that looks for the file
  during an export must look for `.part`. The server and the CLI handle SIGINT/SIGTERM/SIGHUP themselves (cancel, so the
  `.part` file is deleted, then exit); startExport's `handleSignals: false` keeps Playwright's handlers out of it.
- Sending frames from the render page: a `Blob` body is ~10× faster than a typed array.
- ffmpeg colour: keep `flags=accurate_rnd+full_chroma_int(+full_chroma_inp)` on scale filters or colours shift by ~2 levels.
- Run e2e from a lane worktree with its own `E2E_PORT` so parallel runs don't collide.

## Style

Match the surrounding code: TypeScript strict, small pure functions in `src/shared`, comments only where intent isn't
obvious, plain-language tooltips (`title`) on every non-obvious control, `data-testid` on controls tests touch.
