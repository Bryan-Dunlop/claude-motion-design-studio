# Lane B — app, audio, UX, export

Per feature: what the user sees, the tests that cover it, measured numbers. (The lead turns this into the README.)

## B1. Audio

### What the user gets

- **Import sounds**: `Import asset…` (and drag-and-drop onto the preview) now accepts MP3, WAV, OGG, M4A, AAC and FLAC.
  The file is stored byte-for-byte like images. The Import tooltip, the file picker's `accept` list, the drop hint
  ("Drop images (PNG, JPG, WebP, SVG), fonts or sounds (MP3, WAV, OGG, M4A, AAC, FLAC)") and the empty-project hint say so.
- **Sensible placement, no decisions needed**: a file at least as long as the project (music) starts at 0:00 and is cut
  to the project length with a gentle fade-out (min(1.5 s, length/4)); a shorter file (sound effect) goes to the
  playhead at full length (shortened + faded if it would run past the end; moved back if the playhead is at the very
  end). Importing adds the file and its clip as **one** undo step and shows a toast:
  `Added music.mp3 at 0:00 — see the Audio rows`.
- **Timeline**: a collapsible `▾ Audio (n)` block under the layer rows, one row per clip with its waveform (only the
  part of the file that plays). Drag a clip to move it, drag its left edge to trim the start (the end stays put — the
  clip's start and "skip into file" move together), drag its right edge to change the length (never past the end of the
  file). Each drag is one undo step. Clicking a clip selects it and clears the layer selection (and selecting a layer
  clears the clip selection). Muted clips are dimmed; a clip whose file is missing gets a red dashed border. Collapsed,
  the block shows thin summary bars. The collapsed/expanded state is remembered.
- **Clip properties** (right panel): `Name`, `Starts at (s)`, `Skip into file (s)` (tooltip "Jump past a silent
  intro"; the length shrinks if needed so the clip stays inside the file), `Length (s)` (at most the rest of the file),
  `Volume %` (0–400), `Fade in (s)`, `Fade out (s)`, `Mute`, `▶ Preview` (plays just this clip) and `Delete`. With
  several clips selected: `Volume %`, `Mute`, `Delete clips`. A warning shows when the clip starts after the end of the
  video or its file is missing.
- **Keyboard**: `Delete`/`Backspace` deletes the selected clips; `Ctrl+D` duplicates them at the playhead (the earliest
  one lands on the playhead, the others keep their spacing). `Esc` clears the clip selection.
- **Assets list**: sounds show `♪`, their length, and a `+ at playhead` button (adds a clip of that sound at the
  playhead).
- **Click sounds**: every cursor click is drawn as a `●` on the cursor layer's timeline row (blue when it plays a sound;
  clicking it selects the cursor and moves the playhead there). The Cursor panel has a `Click sound` picker (None or any
  imported sound) and its `Volume %` — one undo step each. Each click then plays the sound once; nothing is stored per
  click, so the sounds follow the clicks when you move, duplicate, paste or undo them.
- **Hearing it**: audio plays during preview playback (Web Audio) and stays in sync with play, pause, seeking while
  playing, loop wrap-around and `▶ Preview` buttons. Editing audio while playing restarts the sound from the playhead;
  editing anything else (e.g. dragging layers) doesn't interrupt it. A `🔊 Sound` / `🔇 Sound` toggle after `Loop` mutes
  the preview only (remembered between sessions; the export is never affected). While files are still being decoded the
  playback bar shows "preparing audio…" and those clips join in as soon as they are ready. If the browser can't decode a
  format (e.g. AAC in Chromium builds without proprietary codecs), the import still works (the server decodes it with
  ffmpeg for its length and waveform) and Play shows "music.m4a: can't preview this format in this browser — the export
  will include it."
- **Preview sounds like the export**: the preview uses the export's exact rules for what is audible, lengths and fades,
  and plays mono files at −3 dB per channel like ffmpeg's stereo up-mix (otherwise mono files would preview 3 dB louder
  than they export).
- **Export**: the MP4 gets an AAC stereo 48 kHz track (192 kb/s) with every audible clip and click sound mixed at its
  place, exactly as long as the video and starting at 0. Muted / 0% / after-the-end clips are left out; with no audible
  clip the file has no audio track. A missing sound file doesn't stop the export: it is skipped and the Export dialog
  lists "Audio file missing: x.wav — exported without it." (the CLI prints the same as a warning). The CLI export
  (`npm run render`) includes the audio too.
- **Missing files**: if a sound's file is gone, the Assets list shows `Missing: x.wav — Relink…`, accepting sound files
  only; relinking keeps every clip's settings. Relink now refuses a file of the wrong kind (e.g. an image for a sound),
  and relinking an audio file no longer fails with "could not decode image".
- **Robust export**: if ffmpeg doesn't exit within 30 s after the last frame (it can hang and then ignores SIGTERM), it
  is killed (SIGKILL) and the export fails with a clear message instead of hanging forever.

### How it works (for maintainers)

- `src/shared/audioPlan.ts` — `resolveClips(project)` applies the export's skip/clamp rules (skip muted, volume 0,
  start ≥ video end, missing file, trimStart ≥ file − 1 ms; `DUR = min(duration, file − trimStart, videoEnd − start)`,
  `FI/FO = min(fade, DUR)`, video end = `frameCount/fps`) and expands click sounds into virtual clips at
  `scene.start + layer.start + click.time` (visible cursor layers only; clicks outside the layer or scene are skipped).
  `planAudio(project, fromTime)` adds delay / file offset / remaining length for the preview; `clipGain` is the envelope
  (linear fades that multiply, like two `afade`s).
- `server/audioMix.ts` — `buildAudioArgs(project, fileFor)`: one `-i` per audible clip and the verified graph
  `atrim=start=TS:duration=DUR,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=V[,afade=t=in:st=0:d=FI][,afade=t=out:st=OS:d=FO],adelay=START_MS:all=1`
  per clip, then `amix=inputs=n:normalize=0:duration=longest,asetpts=N/SR/TB,apad=whole_len=NS,atrim=end_sample=NS`
  with `NS = round(frameCount/fps · 48000)`; `-map 0:v -map [aout]`, and `-c:a aac -b:a 192k -ar 48000` before
  `-movflags +faststart`. A fade is only emitted when > 0 (`d=0` means 44100 samples in ffmpeg). Missing files → one
  warning per file on the job (`job.warnings`, returned by `/api/jobs/:id`). The exporter gets an asset resolver from the
  server / CLI (project folder, then the scratch store). Watchdog in `finishFrames`: 30 s, then `fail()` (SIGKILL);
  `MOTION_FFMPEG_EXIT_TIMEOUT_MS` overrides the 30 s for tests.
- `server/audioDecode.ts` + `GET /api/audio-info?project&path&hash` — ffmpeg decode to 8 kHz mono f32 (streamed, no
  full buffer kept): length = sample count / 8000 (not ffprobe's container duration, which is wrong for ADTS/MP3), peaks
  = max |sample| per 10 ms.
- `src/app/audio/waveform.ts` — length + peaks per content hash: `new OfflineAudioContext(1, 1, 8000).decodeAudioData`,
  falling back to `/api/audio-info`; `drawWaveform` draws the trimmed region.
- `src/app/audio/engine.ts` — one full-rate `AudioBuffer` per asset hash, decoded in the background on an
  `OfflineAudioContext(2, 1, 48000)` (no autoplay-restricted context needed until Play) and released when no asset uses
  it; a failed fetch (404) marks the asset missing (`store.setMissingAudio` → Relink). `startAudio(t)` / `stopAudio()`
  are driven by `usePlayback` in App.tsx (play, loop wrap, seek, pause). Each clip = BufferSource → GainNode (fade in)
  → GainNode (volume × fade out) → master. Restarts only when the resolved plan (or an audio asset's file) changes —
  compared by value, so renaming a clip or moving a layer doesn't restart it. `window.__motion.audio()` exposes what is
  scheduled, for tests.
- `src/app/audio/clips.ts` — pure rules: `newClip` defaults, `moveClip`, `trimClipLeft`, `trimClipRight`,
  `duplicateClipsAt`, `clockLabel`.
- `src/app/prefs.ts` — `usePrefs` (localStorage `motion-studio.prefs`): `soundOn`, `audioCollapsed`. B2's toggles
  (Snap, Guides, …) can be added here.
- `usePlayback` now also notices when the playhead is moved during playback (a seek) and continues from there.

### Tests

Unit (vitest):
- `tests/unit/app-audioMix.test.ts` — `buildAudioArgs` table test: single clip at 0, placed/trimmed/quieter clip, clip
  at/after the end → skipped (no audio stream), trimStart ≥ file (and within 1 ms) → skipped, muted / volume 0 →
  skipped, fades longer than the clip → clamped, fades inside the clip (`OS = DUR − FO`), clip past the video end / past
  the file end → cut, non-integer `durationSec·fps` (2.01 s @ 30 fps → `whole_len=96000`), fractional start
  (`adelay=1033.333333`), two clips + a skipped one (input numbering), `d=0` never emitted; one `-i` per clip; missing
  files → one warning, others still mixed; only missing → no stream but the warning; cursor click sounds → one clip per
  click inside the layer, hidden cursor silent; full exporter command order (`ffmpegArgs`); `num()` formatting.
- `tests/unit/app-audioPlan.test.ts` — `planAudio` from 0 / mid-clip / after the end, all skip reasons, clamping to file
  and video end, video end = whole frames, **preview == export** (planned values equal the numbers parsed out of the
  ffmpeg graph), gain envelope incl. overlapping fades, click-sound virtual clips (position, layer/scene range, hidden
  cursor, no sound), `audioPlanKey` changes only when what is heard changes.
- `tests/unit/app-clips.test.ts` — new-clip defaults (music at 0 + fade-out, exactly project length, SFX at the playhead,
  near the end shortened + faded, playhead at the end, `+ at playhead`), names, move/trim-left/trim-right limits, tidy
  rounding, duplicate at the playhead keeping spacing, clock labels.

Playwright:
- `tests/e2e/app-audio.spec.ts`
  - "import a WAV through the UI…" — accept list + tooltip; WAV via the file input → `Audio (1)` row, toast, asset +
    clip = one undo step, defaults; the waveform canvas is drawn (>30% of its pixels inked for a steady tone); the
    properties show every label; volume / fade / mute / name edits = one step each; Skip-into-file shrinks the length;
    drag move +1 s, trim left +0.5 s (end fixed), trim right −0.5 s, right edge capped at the file end, left edge capped
    at the file start — one undo step per drag, undo/redo; layer ↔ clip selection clearing; Ctrl+D at the playhead;
    Delete; `+ at playhead`; collapse remembered in localStorage.
  - "music longer than the project…" — 5 s file in a 3 s project → start 0, length 3, fade-out 0.75; a 1 s file at
    2.5 s → shortened to 0.5 s with a 0.125 s fade, toast `Added whoosh.wav at 0:02.5 — see the Audio rows`.
  - "cursor click sound…" — ● marker at 1.40 s, picker = one undo step, volume, marker turns blue, three clicks → the
    engine schedules three sounds at 0.5 / 1.4 / 1.6 s, back to None.
  - "missing WAV…" — (the "missing asset" test, for a WAV) delete the saved file → reopen → `Missing: lost.wav —
    Relink…` with the audio-only `accept`, the clip bar marked missing, an export still finishes and the dialog shows
    the warning, relinking clears it and keeps the clip's settings.
  - "Sound toggle… preview engine follows play, pause, seek, loop and audio edits" — scheduled source, mono −3 dB gain,
    a volume edit restarts (generation +1) while adding/moving a layer doesn't, play from 1.2 s → file offset 1.2,
    seek while playing → restarts at the new time, loop wrap → restarts near 0, Sound off → nothing scheduled, back on
    while playing → plays, preference survives a reload.
  - "formats the browser cannot decode (AAC here)…" — an .m4a imports via the server fallback (length ≈ 2 s, waveform
    drawn), the engine marks it unsupported and Play shows the toast (skipped automatically if the browser can decode AAC).
- `tests/e2e/app-audio-export.spec.ts` (320×180, 3 s, 30 fps; real exports)
  - "export mixes audio clips…" — AAC, 48 kHz, stereo; audio `start_time` 0 and duration == video duration (3.000);
    RMS windows (left channel) prove placement, trim, mute, volume and both fades; video frames still match renderFrame.
  - "CLI export includes the same audio" — same checks for `npm run render` with a fresh workspace (sounds found in the
    project folder).
  - "missing audio files are skipped with a warning…" — one warning for two clips of the same missing file, the other
    clip still mixed; only missing/silent clips → no audio stream.
  - "watchdog…" (POSIX only) — a fake ffmpeg that swallows the frames and then hangs ignoring SIGTERM: with the timeout
    at 1.5 s the CLI fails with "ffmpeg did not finish within 1.5 s after the last frame…" and the process is gone.

### Measured

- Export RMS per window (left channel; mono source 0.5 amplitude → 0.25 after ffmpeg's −3 dB up-mix; stereo source at
  50% → 0.177): `0–0.45 s: 0`, `0.55–1.45 s: 0.2500` (placed + trimmed), `1.55–1.75 s: 0` (muted clip), fade-in
  `1.8–1.9: 0.017`, `2.0–2.1: 0.074`, `2.3–2.4: 0.162`, full `2.4–2.6: 0.1768`, fade-out `2.7–2.8: 0.111`,
  `2.9–3.0: 0.0255`. Audio and video streams both `start_time=0.000000`, `duration=3.000000`. Same numbers from the CLI.
- Video with audio still matches renderFrame: PSNR 40.1–40.3 dB, mean abs diff 0.53–0.55 (frames 0, 45, 89).
- 5-minute MP3, import in Chromium: low-rate decode + peaks 750 ms (30 000 peaks); the full-rate playback buffer
  1.3 s / 115 MB (decoded in the background). Server fallback (`/api/audio-info`): 1.19 s, 176 KB JSON, length 300.000 s
  (ffprobe's container duration says 300.042 s).
- Audio export tests take ~2–3 s each; the watchdog test ~3.6 s.
- Robustness check (manual, ffmpeg 6.1.1): a clip whose stored file length is wrong (so `atrim` yields nothing), alone or
  mixed with another clip, still finishes immediately with audio exactly as long as the video (2.000 s) — the verified
  `asetpts=N/SR/TB,apad=whole_len,atrim=end_sample` tail doesn't hang on empty input.

### Not done / limitations

- Clips using the same file each get their own ffmpeg input (the optional `asplit` sharing was not implemented). Fine for
  normal projects; a cursor with ~100+ click sounds makes a long command line (Windows limit 32 767 characters).
- Sources with more than two channels are down-mixed slightly differently by Web Audio (preview) and ffmpeg (export).
- Preview sound starts when the browser allows it (after a click or key press on the page — always the case when you
  press Play).
- The "missing asset" WAV case is its own test in `app-audio.spec.ts` (not added to `editor.spec.ts`).

## B2. Timeline & preview UX

### What the user gets

- **Selecting keyframes**: click a ◆ diamond in the timeline to select it (on a layer's own row a diamond stands for
  every keyframe at that time); **Shift-click adds** it, Shift-click on a selected one takes it out again. Adding a
  keyframe with ◆ in the Properties panel selects it too. Selected diamonds are drawn white with a blue ring (half white
  when only some of the keys at that time are selected). The playhead jumps to the diamond you press; its tooltip
  gives the time on the ruler and the properties.
- **Keyframe panel** (pinned under the layer name): `Keyframe easing (n selected)` with the easing picker for all
  selected keyframes (one undo step), the properties they belong to in plain words ("X position, Opacity"), a hint
  "Reuse this motion: Ctrl+C, select another layer, Ctrl+V." and a `Delete keyframe` / `Delete n keyframes` button. It
  also shows when the selected keyframes are on several layers.
- **Moving keyframes**: drag a diamond to move it in time; dragging a diamond that is part of the selection moves the
  whole selection by the same amount (each key stays inside its layer). One drag = one undo step.
- **Keyframe rows**: a `▸` in front of an animated layer's name in the timeline opens one row per animated property,
  named like everywhere else in the app (`X position`, `Opacity`, `Trim end`, `Shadow softness`…, in Properties
  order). Dragging a diamond there moves only that keyframe; clicking a row's name selects all its keyframes (Shift
  adds).
- **Keyboard** (never while typing in a field; a focused checkbox still toggles with Space):
  - `Delete` / `Backspace`: the selected keyframes if any (the layer stays), else the selected audio clips, else the
    selected layers. A property whose last keyframe is deleted keeps its normal (static) value.
  - `Esc`: first clears the keyframe selection, then the clip / layer selection. An open menu takes the `Esc` itself.
  - `Ctrl+C`: copies the selected keyframes if any, else the selected audio clips, else the selected layers (a toast
    confirms). `Ctrl+V` pastes:
    - **keyframes** onto every selected layer at the playhead (the first copied key lands on the playhead, the rest
      keep their spacing, clamped to the layer). X/Y are **relative**: the motion starts from where each layer is now
      (copy a "move 400 px right" and it moves that layer 400 px right from its own position); other properties paste
      as they were. Properties the layer can't animate are skipped and the toast says so:
      `Pasted 6 keyframes (2 skipped: not available on text)`. If the playhead is outside a layer, nothing is pasted
      there: `Move the playhead inside "Text" to paste keyframes there.` A keyframe already on the same frame is
      replaced. `Ctrl+Shift+V` pastes the exact copied values instead. The pasted keyframes become the selection.
    - **layers** into the selected scene at the same timing inside the scene (new copies; a name already used in that
      scene gets " copy"); the pasted layers become the selection. Their images, fonts and click sounds come along.
    - **audio clips** at the playhead (earliest one there, the rest keep their spacing).
    Everything pasted is one undo step. Copying works across projects (the clipboard lives until the page is closed).
  - `Ctrl+D`: duplicates the selected layers, else the selected clips (unchanged from B1).
- **Snapping while moving layers in the preview** (`Snap` button, on by default): the selection's left / centre /
  right and top / middle / bottom snap to the frame edges and centre, to the other visible layers' edges and centres,
  and (with Guides on) to the safe box, within 8 screen pixels. Magenta lines show what it snapped to. Hold
  `Ctrl` (`⌘` on a Mac) to move freely. With Shift (move along one axis only) the locked axis never snaps.
- **Snapping in the timeline**: dragging a layer bar (move or either edge), a scene block (move or either edge), an
  audio clip (move or either edge) or keyframes snaps to the playhead, the project start/end, scene boundaries, the
  other bars and clips, keyframes and cursor clicks within 8 pixels; a magenta line shows the snap. `Ctrl`/`⌘` or Snap
  off: whole frames only. (A keyframe drag snaps to where the playhead was before you pressed the diamond.)
- **Guides** button: centre lines, rule-of-thirds lines and one safe box over the preview (never in the export). For
  9:16 the box is the area Reels/TikTok leave free of their buttons and captions (6% sides, 14% top, 35% bottom; the
  covered part is hatched; label `Reels/TikTok UI`), for every other format a 90% `Title safe` box.
- **Marquee**: drag on empty preview space (also the grey area around the frame) to select every unlocked layer the
  rectangle touches (live while dragging); Shift adds to the selection. A plain click on empty space clears the
  selection as before.
- **Easier clicking**: layers are hit within 6 screen pixels around their outline, at any zoom; a line is hit near
  the line itself (half its stroke or 6 screen pixels), not anywhere in its box.
- **Playback bar**: `⟳ Loop`, `Snap`, `Guides`, `🔊 Sound` — Snap and Guides are remembered between sessions.
- **Bigger timeline when you need it**: drag the line between the preview and the timeline (default 240 px, at least
  160 px, at most 60% of the window; remembered). Toasts move up with it. The ruler and the Scenes row stay at the top
  while you scroll through many layers.
- **Menus**: `+ Shape ▾`, `More ▾` and a new `File ▾` (with `Export .zip` and `Import .zip`, which used to be two
  toolbar buttons) close when you pick an item, click anywhere else or press Esc; opening one closes the other.
- **No accidental text selection**: Shift-clicking diamonds, bars or list rows no longer selects page text (which
  used to make the next drag start a browser text-drag and cancel it).

### How it works (for maintainers)

- `src/app/snapping.ts` (pure): `snapAxis` (closest moving position → target within a threshold), `snapMove`
  (selection bounds, per-axis snapping, Shift locks, guide lines = targets the snapped edges touch), `moveTargets`,
  `safeArea` / `isVertical916` / `guideLines`, hit-testing (`hitPolygon` = inside or within `pad` of the outline,
  `distToSegment`), marquee overlap (`polygonIntersectsBox`, separating-axis test on the real rotated outline) and
  `timelineTargets(project, {playhead, sceneId, exclude})`. `SNAP_PX = 8`.
- `src/app/timelineSnap.ts`: `timeSnapper({edges, exclude, sceneId?, playhead?, anchor?})` for one timeline drag
  (snapped offset or whole frames) + `useTimeSnapLine` for the magenta line. Used by Timeline.tsx and AudioRows.tsx.
  What moves with a drag is excluded (a moved bar's keys/clicks, a scene's layers when its start moves, the dragged
  keys / clips).
- `src/app/clipboard.ts` (pure, unit-tested): `copyKeys` (absolute times, `structuredClone`d), `copyLayers` /
  `copyClips` (+ the assets they use), `pasteKeys(draft, targets, keys, time, {relative, newId})` → `{ids, skipped,
  skippedTypes, refused}`, `pasteKeysMessage`, `pasteLayers` (via `deepCloneLayer`), `pasteClips`.
- `actions.ts`: `deleteKeys`, `copySelection`, `pasteClipboard({absolute})` (in-memory clipboard; each paste is one
  `commit` and then selects what was pasted).
- `components/Menu.tsx`: `Menu` / `MenuItem` and `useDismiss(active, ref, onDismiss)` (window pointerdown + Escape in
  the capture phase; Escape is consumed).
- `prefs.ts`: `snap` (true), `guides` (false), `timelineHeight` (240) + `clampTimelineHeight`.
- Preview: the pointer handler sits on the whole preview area (so the marquee can start outside the frame); handles
  stop propagation as before.

### Tests

Unit (vitest):
- `tests/unit/app-snapping.test.ts` — `snapAxis` (closest pair, threshold inclusive, ties), move targets, centre lands
  exactly on the frame centre (with guides), edges onto frame edges and another layer's edge, no snap outside the
  threshold, Shift-locked axis, 9:16 Reels box (6/14/35%) vs 90% title-safe for 16:9, 1:1, 4:5, 16:10, centre/thirds,
  point-in-polygon / pad / segment distance, marquee overlap with a rotated outline, timeline targets (playhead,
  project, scenes, bars, keys, clicks inside the layer only, clips) and exclusions.
- `tests/unit/app-clipboard.test.ts` — copy keeps absolute times / easing / preset tag as unfrozen clones; relative
  x/y paste from the target's animated value; absolute paste; same-frame replacement; several targets with skipped
  properties and the toast text; clamping to the layer; refusal when the playhead is outside; two keys clamped onto one
  frame; layer paste (scene-relative timing, new ids incl. keys/points/clicks, " copy" names, assets carried into
  another project); clip paste at the playhead.
- `tests/unit/app-prefs.test.ts` — Snap on / Guides off / 240 px by default; the splitter clamp (160 px … 60% of the
  window, the minimum wins in a tiny window).

Playwright:
- `tests/e2e/app-keyframes.spec.ts`
  - "select diamonds (Shift adds)…" — ◆ selects, click / Shift-click / Shift-click again, `Keyframe easing (n
    selected)`, one easing change for 4 keys = 1 undo step, **select a diamond + Delete keeps the layer** (1 step),
    undo restores unselected keys, the panel's Delete button, Backspace, then Delete removes the layer, Esc order
    (keys, then layers), undo drops a selected key from the selection.
  - "▸ shows one row per animated property…" — labels `X position`, `Opacity`, `Trim end`, `Shadow softness`;
    dragging the x diamond on its row moves only that key (opacity's key at the same time stays; 1 undo step);
    dragging a selected diamond moves the whole selection; clicking a row label selects its keys (Shift adds).
  - "Ctrl+C / Ctrl+V keyframes…" — 6 keys copied; **relative x/y paste** onto a text at 2 s (1920→2320 becomes
    1000→1400, 1080→1280 becomes 500→700), selected, 1 undo step; `Ctrl+Shift+V` absolute; paste onto text + cursor:
    `Pasted 8 keyframes (4 skipped: not available on cursor)` and the 8-key multi-layer panel; playhead outside the
    layer → refusal toast and no undo step.
  - "Ctrl+C / Ctrl+V layers…" — Esc first so Ctrl+C takes the layer, paste into Scene 2 at the same start (new ids),
    second paste → `Rectangle copy`, Ctrl+D with a key selected duplicates the layer, empty clipboard toast.
- `tests/e2e/app-snapping.spec.ts`
  - "preview move: … exact frame centre…" — Ctrl-drag moves freely; a drag ending 3/2 screen px off the centre lands on
    **exactly (1920, 1080)** with magenta guides at 1920/1080 while dragging (1 undo step); **Ctrl disables** it; Snap
    off disables it; Snap is on by default and remembered.
  - "…edges to other layers and to the frame edges" — ellipse's left edge onto the rectangle's right edge (2244, guide
    shown), rectangle's left edge onto x = 0.
  - "Guides…" — 16:9 title-safe box 192/108/3456/1944, 2 centre + 4 thirds lines, not drawn into the canvas; 9:16 →
    Reels/TikTok box (129.6/537.6/1900.8/1958.4) and a move snapping to its edge; remembered.
  - "marquee…" — live selection while dragging, Shift adds, click on empty space clears, locked layers skipped, a line
    is hit ~17 px from its segment but not ~38 px away inside its box.
  - "timeline: keyframes and layer bars snap to the playhead…" — key lands on 2 s with the magenta line at 2 s, bar
    start onto 3 s, Ctrl → 2 frames, Snap off → 4 frames.
  - "timeline: a scene edge snaps to a layer bar end, a sound clip to a cursor click" — scene end → 10 s, clip start →
    1.4 s.
- `tests/e2e/app-layout.spec.ts`
  - "menus close on an outside click and on Escape…" — + Shape ▾ closes on outside pointerdown, on Escape (the
    selection survives that Escape), after picking Star, on a second click, when File ▾ opens; File ▾ items; More ▾
    items disabled.
  - "the timeline splitter…" — 240 → 340 px (the preview shrinks), clamped at 160 and 570 (60% of 950), toasts at
    580 px, remembered after reload; with 25 layers scrolled down the ruler and the Scenes row stay at the top.
  - "a focused checkbox keeps Space…" — Space toggles the focused Mute box (no playback), Delete still deletes the clip.
- `tests/e2e/ui-export-zip.spec.ts` (edited): Export .zip and Import .zip now go through `File ▾` (the menu closes after
  the pick; Import opens the `.zip` file chooser).

### Measured

- Snap distance: 8 screen px. In the default 1500×950 test window a 4K 16:9 preview is 908 px wide, so 8 px = 33.8
  project px; a 9:16 4K preview is 336 px wide (8 px = 51 project px). In the timeline at the default zoom (60 px/s)
  8 px = 0.133 s (4 frames at 30 fps).
- Snapped positions are exact: centre 1920.000/1080.000, edge 2244 → x = 2568, frame edge → x = 324, Reels box edge
  129.6 → x = 453.6; timeline snaps land exactly on 2 s, 3 s, 10 s and 1.4 s.
- The three B2 spec files (13 tests) run in about 15 s; the whole e2e suite (41 tests) in about 1.1 min.

### Not done / limitations

- Timeline rows are labelled with the shared table's long names (`X position`, `Shadow softness`) — the spec's
  examples said `X` / `Shadow blur`; the table (src/shared/propLabels.ts) is the single source, so it wins.
- Line hit-testing uses `strokeWidth × |scale| / 2` (the spec wrote `strokeWidth/2`; same at scale 1).
- Menus have no arrow-key navigation (Tab + Enter work).
- Copy/paste is in-memory (not the system clipboard), so it doesn't work between two browser tabs.
