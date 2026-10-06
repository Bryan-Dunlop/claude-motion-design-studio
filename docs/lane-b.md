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
