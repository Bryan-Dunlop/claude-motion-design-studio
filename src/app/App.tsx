import { useEffect, useRef, useState } from 'react';
import { frameCount } from '../shared/renderFrame';
import type { ShapeKind } from '../shared/schema';
import {
  addCursor,
  addScene,
  addShape,
  addText,
  copySelection,
  deleteClips,
  deleteKeys,
  deleteLayers,
  downloadZip,
  duplicateClips,
  duplicateLayers,
  importFiles,
  importZip,
  IMPORT_ACCEPT,
  newProject,
  pasteClipboard,
  saveProject,
} from './actions';
import { startAudio, stopAudio, useAudioEngine, useAudioStatus } from './audio/engine';
import { ExportDialog, OpenDialog, SaveAsDialog } from './components/Dialogs';
import { LayersPanel } from './components/LayersPanel';
import { Menu, MenuItem } from './components/Menu';
import { Preview } from './components/Preview';
import { Properties } from './components/Properties';
import { Timeline } from './components/Timeline';
import { clampTimelineHeight, usePrefs } from './prefs';
import { useResourceLoader } from './resources';
import { downloadStill } from './still';
import { isDirty, snapToFrame, useEditor } from './store';

type DialogKind = 'open' | 'saveAs' | 'export' | null;

const NOT_AVAILABLE = ['Video clips', 'AI generation', 'Cloud sync'];

const SHAPE_MENU: { kind: ShapeKind; label: string }[] = [
  { kind: 'rect', label: 'Rectangle' },
  { kind: 'ellipse', label: 'Ellipse' },
  { kind: 'triangle', label: 'Triangle' },
  { kind: 'star', label: 'Star' },
  { kind: 'polygon', label: 'Polygon' },
  { kind: 'line', label: 'Line' },
];

function formatTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * Keys typed into a text field belong to it. Checkboxes and other button-like inputs keep Space/Enter (to toggle
 * them) but don't swallow the editor shortcuts (Delete, Ctrl+Z…).
 */
function isTyping(el: HTMLElement, key: string) {
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  if (['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color'].includes((el as HTMLInputElement).type)) return key === ' ' || key === 'Enter';
  return true;
}

function useWindowHeight() {
  const [h, setH] = useState(window.innerHeight);
  useEffect(() => {
    const onResize = () => setH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return h;
}

export function App() {
  useResourceLoader();
  useAudioEngine();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const projectName = useEditor((s) => s.projectName);
  const dirty = useEditor(isDirty);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const toasts = useEditor((s) => s.toasts);
  const fileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const timelineHeight = clampTimelineHeight(usePrefs((s) => s.timelineHeight), useWindowHeight());

  // Unsaved-changes dot in the title + warning when closing the tab.
  useEffect(() => {
    document.title = `${dirty ? '● ' : ''}${projectName ?? 'Untitled'} — Motion Studio`;
  }, [dirty, projectName]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (isDirty(useEditor.getState())) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  usePlayback();

  const save = () => (useEditor.getState().projectName ? saveProject() : setDialog('saveAs'));

  // Keyboard shortcuts. Delete/Backspace and Ctrl+C act on the selected keyframes first, then clips, then layers;
  // Esc clears keyframes first (store.clearSelectionStep). Open menus take Esc themselves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTyping(e.target as HTMLElement, e.key);
      const st = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') {
        e.preventDefault();
        if (e.shiftKey) setDialog('saveAs');
        else void save();
        return;
      }
      if (typing || dialogOpen()) return;
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        st.redo();
      } else if (mod && key === 'c') {
        if (copySelection()) e.preventDefault();
      } else if (mod && key === 'v') {
        e.preventDefault();
        pasteClipboard({ absolute: e.shiftKey });
      } else if (mod && key === 'd') {
        e.preventDefault();
        if (st.selection.layerIds.length) duplicateLayers(st.selection.layerIds);
        else if (st.selection.audioIds.length) duplicateClips(st.selection.audioIds);
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const fps = st.project.settings.fps;
        st.setPlaying(false);
        st.setTime(snapToFrame(st.time, fps) + ((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)) / fps);
      } else if (e.key === 'Home') {
        st.setTime(0);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.selectedKeys.length) {
          e.preventDefault();
          deleteKeys(st.selectedKeys);
        } else if (st.selection.audioIds.length) {
          e.preventDefault();
          deleteClips(st.selection.audioIds);
        } else if (st.selection.layerIds.length) {
          e.preventDefault();
          deleteLayers(st.selection.layerIds);
        }
      } else if (e.key === 'Escape') {
        st.clearSelectionStep();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const confirmDiscard = () => !isDirty(useEditor.getState()) || confirm('You have unsaved changes. Discard them?');

  return (
    <div className="app" style={{ gridTemplateRows: `auto 1fr ${timelineHeight}px` }}>
      <header className="toolbar">
        <div className="group">
          <strong className="brand">Motion Studio</strong>
          <span className="doc-name" data-testid="doc-name">
            {dirty && <span className="dirty-dot" title="Unsaved changes" data-testid="dirty-dot">●</span>}
            {projectName ?? 'Untitled'}
          </span>
        </div>
        <div className="group">
          <button onClick={() => confirmDiscard() && newProject()} title="Start a new empty project">New</button>
          <button onClick={() => setDialog('open')} title="Open a saved project folder" data-testid="btn-open">Open…</button>
          <button onClick={save} title="Save (Ctrl+S)" data-testid="btn-save">Save</button>
          <button onClick={() => setDialog('saveAs')} title="Save under a new name (Ctrl+Shift+S)">Save as…</button>
          <Menu label="File ▾" title="Share a whole project as one .zip file, or open one" testId="file-menu">
            <MenuItem onClick={downloadZip} title="Download the whole project (project.json + assets) as one .zip file" testId="file-export-zip">
              Export .zip
            </MenuItem>
            <MenuItem onClick={() => zipInput.current?.click()} title="Import a project .zip into your workspace" testId="file-import-zip">
              Import .zip
            </MenuItem>
          </Menu>
        </div>
        <div className="group">
          <button onClick={() => useEditor.getState().undo()} disabled={!canUndo} title="Undo (Ctrl+Z)" data-testid="btn-undo">↶</button>
          <button onClick={() => useEditor.getState().redo()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" data-testid="btn-redo">↷</button>
        </div>
        <div className="group">
          <button onClick={addScene} title="Add a scene">+ Scene</button>
          <button onClick={addText} title="Add a text layer" data-testid="add-text">+ Text</button>
          <button onClick={() => addShape('rect')} title="Add a rectangle" data-testid="add-rect">+ Rect</button>
          <Menu label="+ Shape ▾" title="Add a shape layer" testId="add-shape-menu" className="shape-menu">
            {SHAPE_MENU.map((sh) => (
              <MenuItem key={sh.kind} testId={`add-shape-${sh.kind}`} title={`Add a ${sh.label.toLowerCase()}`} onClick={() => addShape(sh.kind)}>
                {sh.label}
              </MenuItem>
            ))}
          </Menu>
          <button onClick={addCursor} title="Add an animated mouse cursor with click ripples" data-testid="add-cursor">+ Cursor</button>
          <button
            onClick={() => fileInput.current?.click()}
            title="Import images (PNG, JPG, WebP, SVG), fonts (TTF, OTF, WOFF) or sounds (MP3, WAV, OGG, M4A, AAC, FLAC). You can also drag files onto the preview."
            data-testid="btn-import"
          >
            Import asset…
          </button>
          <Menu label="More ▾" title="Features that are not part of this version" testId="more-menu">
            {NOT_AVAILABLE.map((n) => (
              <MenuItem key={n} disabled title={`${n} is not available in this version`} testId={`more-${n.toLowerCase().replace(/\s+/g, '-')}`}>
                {n} — Not available
              </MenuItem>
            ))}
          </Menu>
        </div>
        <div className="group right">
          <button className="primary" onClick={() => setDialog('export')} title="Render the project to an MP4 video file" data-testid="btn-export">
            Export MP4
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept={IMPORT_ACCEPT}
          data-testid="file-input"
          onChange={(e) => {
            void importFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <input
          ref={zipInput}
          type="file"
          hidden
          accept=".zip"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && confirmDiscard()) void importZip(f);
            e.target.value = '';
          }}
        />
      </header>
      <main className="main">
        <LayersPanel />
        <section className="center">
          <Preview />
          <PlaybackBar />
        </section>
        <aside className="right-panel">
          <Properties />
        </aside>
      </main>
      <Timeline />
      {dialog === 'open' && <OpenDialog onClose={() => setDialog(null)} />}
      {dialog === 'saveAs' && <SaveAsDialog onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
      <div className="toasts" style={{ bottom: timelineHeight + 10 }}>
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => useEditor.getState().dismissToast(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function dialogOpen() {
  return !!document.querySelector('.modal');
}

function togglePlay() {
  const st = useEditor.getState();
  if (!st.playing && st.time >= st.project.settings.durationSec - 1e-6) st.setTime(0);
  st.setPlaying(!st.playing);
}

/**
 * Preview clock. Only the playhead advances; frames are still drawn by renderFrame(project, time). The clock is
 * performance.now()-based; the audio engine follows it: (re)started on play, loop wrap and seek, stopped on pause.
 */
function usePlayback() {
  const playing = useEditor((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let t0 = performance.now();
    let start = useEditor.getState().time;
    let lastSet = start;
    let lap = 0;
    startAudio(start);
    const tick = () => {
      const st = useEditor.getState();
      const dur = st.project.settings.durationSec;
      if (st.time !== lastSet) {
        // The playhead was moved while playing (seek): carry on from there.
        start = st.time;
        t0 = performance.now();
        lap = 0;
        startAudio(start);
      }
      const raw = start + (performance.now() - t0) / 1000;
      let t = raw;
      if (st.playUntil !== null && t >= st.playUntil) {
        st.setTime(st.playUntil);
        st.setPlaying(false);
        return;
      }
      if (t >= dur) {
        if (st.loop) {
          t = t % dur;
          const n = Math.floor(raw / dur);
          if (n !== lap) {
            lap = n;
            startAudio(t);
          }
        } else {
          st.setTime(dur);
          st.setPlaying(false);
          return;
        }
      }
      st.setTime(t);
      lastSet = useEditor.getState().time;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      stopAudio();
    };
  }, [playing]);
}

function PlaybackBar() {
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const loop = useEditor((s) => s.loop);
  const project = useEditor((s) => s.project);
  const soundOn = usePrefs((s) => s.soundOn);
  const snap = usePrefs((s) => s.snap);
  const guides = usePrefs((s) => s.guides);
  const setPref = usePrefs((s) => s.setPref);
  const preparing = useAudioStatus((s) => s.preparing);
  const st = useEditor.getState;
  const fps = project.settings.fps;
  const total = frameCount(project);
  const frame = Math.min(total - 1, Math.floor(time * fps + 1e-6));
  const step = (d: number) => {
    st().setPlaying(false);
    st().setTime(snapToFrame(st().time, fps) + d / fps);
  };
  return (
    <div className="playback">
      <button onClick={() => step(-1)} title="Previous frame (←)">⏮</button>
      <button onClick={togglePlay} title="Play / pause (Space)" data-testid="btn-play" className="play">
        {playing ? '⏸' : '▶'}
      </button>
      <button onClick={() => step(1)} title="Next frame (→)">⏭</button>
      <button
        onClick={() => {
          st().setTime(0);
          st().setPlaying(true);
        }}
        title="Replay from the start"
      >
        ↺
      </button>
      <button className={loop ? 'toggled' : ''} onClick={() => st().setLoop(!loop)} title="Loop playback">
        ⟳ Loop
      </button>
      <button
        className={snap ? 'toggled' : ''}
        onClick={() => setPref({ snap: !snap })}
        title="Snap to edges, centre and other layers (hold Ctrl/⌘ to drag freely)"
        data-testid="btn-snap"
        aria-pressed={snap}
      >
        Snap
      </button>
      <button
        className={guides ? 'toggled' : ''}
        onClick={() => setPref({ guides: !guides })}
        title="Show centre lines, thirds and the safe area over the preview (never exported)"
        data-testid="btn-guides"
        aria-pressed={guides}
      >
        Guides
      </button>
      <button
        className={soundOn ? 'toggled' : ''}
        onClick={() => setPref({ soundOn: !soundOn })}
        title={soundOn ? 'Sound is on while previewing. Click to mute the preview (the export is not affected).' : 'Sound is off while previewing. Click to hear audio clips and click sounds.'}
        data-testid="btn-sound"
        aria-pressed={soundOn}
      >
        {soundOn ? '🔊' : '🔇'} Sound
      </button>
      <button
        onClick={() => void downloadStill()}
        title={`Save this frame as a PNG image at full size (${project.settings.width}×${project.settings.height})`}
        data-testid="btn-png"
      >
        PNG
      </button>
      {preparing > 0 && (
        <span className="muted small" data-testid="audio-preparing" title="Sound files are being decoded for preview; they join in as soon as they are ready.">
          preparing audio…
        </span>
      )}
      <span className="timecode" data-testid="timecode">
        {formatTime(time)} / {formatTime(project.settings.durationSec)}
      </span>
      <span className="frame" data-testid="frame-counter">
        frame {frame} / {total - 1}
      </span>
    </div>
  );
}
