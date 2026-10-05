import { useEffect, useRef, useState } from 'react';
import { frameCount } from '../shared/renderFrame';
import type { ShapeKind } from '../shared/schema';
import { addCursor, addScene, addShape, addText, deleteLayers, downloadZip, duplicateLayers, importFiles, importZip, newProject, saveProject } from './actions';
import { ExportDialog, OpenDialog, SaveAsDialog } from './components/Dialogs';
import { LayersPanel } from './components/LayersPanel';
import { Preview } from './components/Preview';
import { Properties } from './components/Properties';
import { Timeline } from './components/Timeline';
import { useResourceLoader } from './resources';
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

export function App() {
  useResourceLoader();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const projectName = useEditor((s) => s.projectName);
  const dirty = useEditor(isDirty);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const toasts = useEditor((s) => s.toasts);
  const fileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

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

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
      const st = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.shiftKey) setDialog('saveAs');
        else void save();
        return;
      }
      if (typing || dialogOpen()) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateLayers(st.selection.layerIds);
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
        if (st.selection.layerIds.length) {
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
    <div className="app">
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
          <button onClick={downloadZip} title="Download the whole project (project.json + assets) as one .zip file">Export .zip</button>
          <button onClick={() => zipInput.current?.click()} title="Import a project .zip into your workspace">Import .zip</button>
        </div>
        <div className="group">
          <button onClick={() => useEditor.getState().undo()} disabled={!canUndo} title="Undo (Ctrl+Z)" data-testid="btn-undo">↶</button>
          <button onClick={() => useEditor.getState().redo()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" data-testid="btn-redo">↷</button>
        </div>
        <div className="group">
          <button onClick={addScene} title="Add a scene">+ Scene</button>
          <button onClick={addText} title="Add a text layer" data-testid="add-text">+ Text</button>
          <button onClick={() => addShape('rect')} title="Add a rectangle" data-testid="add-rect">+ Rect</button>
          <details className="na-menu shape-menu">
            <summary title="Add a shape layer" data-testid="add-shape-menu">+ Shape ▾</summary>
            <div className="na-list">
              {SHAPE_MENU.map((s) => (
                <button
                  key={s.kind}
                  data-testid={`add-shape-${s.kind}`}
                  title={`Add a ${s.label.toLowerCase()}`}
                  onClick={(e) => {
                    addShape(s.kind);
                    (e.currentTarget.closest('details') as HTMLDetailsElement).open = false;
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </details>
          <button onClick={addCursor} title="Add an animated mouse cursor with click ripples" data-testid="add-cursor">+ Cursor</button>
          <button onClick={() => fileInput.current?.click()} title="Import PNG, JPG, WebP, SVG or fonts (you can also drag files onto the preview)" data-testid="btn-import">
            Import asset…
          </button>
          <details className="na-menu">
            <summary title="Features that are not part of this version">More ▾</summary>
            <div className="na-list">
              {NOT_AVAILABLE.map((n) => (
                <button key={n} disabled title={`${n} is not available in v1`}>
                  {n} — Not available
                </button>
              ))}
            </div>
          </details>
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
          accept=".png,.jpg,.jpeg,.webp,.svg,.ttf,.otf,.woff,.woff2"
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
      <div className="toasts">
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

/** Preview clock. Only the playhead advances; frames are still drawn by renderFrame(project, time). */
function usePlayback() {
  const playing = useEditor((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const t0 = performance.now();
    const start = useEditor.getState().time;
    const tick = () => {
      const st = useEditor.getState();
      const dur = st.project.settings.durationSec;
      let t = start + (performance.now() - t0) / 1000;
      if (st.playUntil !== null && t >= st.playUntil) {
        st.setTime(st.playUntil);
        st.setPlaying(false);
        return;
      }
      if (t >= dur) {
        if (st.loop) t = t % dur;
        else {
          st.setTime(dur);
          st.setPlaying(false);
          return;
        }
      }
      st.setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}

function PlaybackBar() {
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const loop = useEditor((s) => s.loop);
  const project = useEditor((s) => s.project);
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
      <span className="timecode" data-testid="timecode">
        {formatTime(time)} / {formatTime(project.settings.durationSec)}
      </span>
      <span className="frame" data-testid="frame-counter">
        frame {frame} / {total - 1}
      </span>
    </div>
  );
}
