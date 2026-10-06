import { useEffect, useState } from 'react';
import { resolveClips } from '../../shared/audioPlan';
import { EXPORT_SCALES, exportSize, QUALITIES, sizeLabel, type ExportOptions, type QualityId } from '../../shared/exportSize';
import { fitToFrame, formatSize, type Format } from '../../shared/fitToFrame';
import { sameName, sanitizeName } from '../../shared/names';
import { ASPECTS, type Project } from '../../shared/schema';
import { api, listProjects, openProject, saveCopyAs, saveProject } from '../actions';
import { usePrefs } from '../prefs';
import { isDirty, useEditor } from '../store';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function OpenDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<{ name: string; modified: number }[] | null>(null);
  useEffect(() => {
    listProjects().then(setItems, () => setItems([]));
  }, []);
  const open = async (name: string) => {
    if (isDirty(useEditor.getState()) && !confirm('You have unsaved changes. Discard them and open another project?')) return;
    await openProject(name);
    onClose();
  };
  return (
    <Modal title="Open project" onClose={onClose}>
      {!items && <p>Loading…</p>}
      {items && items.length === 0 && <p className="muted">No saved projects yet.</p>}
      <ul className="list open-list">
        {items?.map((p) => (
          <li key={p.name} onClick={() => open(p.name)} data-testid={`open-${p.name}`}>
            <span className="name">{p.name}.motion</span>
            <span className="muted small">{new Date(p.modified).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      <div className="btn-row">
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/**
 * Save as… — or, with `copy`, save that project (e.g. a copy in another format) under a new name and open it. Name
 * clashes are case-insensitive: on Windows and macOS "Promo" and "promo" are the same folder.
 */
export function SaveAsDialog({ onClose, copy, defaultName, title = 'Save project as', onSaved }: { onClose: () => void; copy?: Project; defaultName?: string; title?: string; onSaved?: (name: string) => void }) {
  const current = useEditor.getState().projectName;
  const [name, setName] = useState(defaultName ?? current ?? 'My project');
  const [existing, setExisting] = useState<string[]>([]);
  useEffect(() => {
    listProjects().then((l) => setExisting(l.map((p) => p.name)), () => undefined);
  }, []);
  const clean = sanitizeName(name);
  // Saving the open project under its own name is just Save; a copy never silently replaces it.
  const clash = existing.some((n) => sameName(n, clean)) && (!!copy || !current || !sameName(clean, current));
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!clean) return;
          if (clash && !confirm(`${clean}.motion already exists. Overwrite it?`)) return;
          const ok = copy ? await saveCopyAs(copy, clean) : await saveProject(clean);
          if (!ok) return;
          onSaved?.(clean);
          onClose();
        }}
      >
        <label className="stack">
          Project name (letters, numbers, spaces, - and _)
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="save-name" />
        </label>
        <p className="muted small">Saved as a folder: {clean || '…'}.motion/ containing project.json and assets/</p>
        {clash && <p className="warn">A project with this name exists and will be overwritten.</p>}
        <div className="btn-row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={!clean} data-testid="save-confirm">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

const FORMATS: { aspect: Format; label: string; hint: string }[] = [
  { aspect: '9:16', label: '9:16 vertical', hint: 'Reels, TikTok, Shorts' },
  { aspect: '1:1', label: '1:1 square', hint: 'Instagram, LinkedIn posts' },
  { aspect: '4:5', label: '4:5 portrait', hint: 'Instagram feed' },
  { aspect: '16:9', label: '16:9 landscape', hint: 'YouTube, websites' },
];

/** Project settings → "Make a copy in another format…": pick a format, then name the copy (Save as), which opens. */
export function FormatCopyDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const projectName = useEditor((s) => s.projectName);
  const dirty = useEditor(isDirty);
  const [picked, setPicked] = useState<{ copy: Project; name: string; aspect: Format } | null>(null);
  if (picked)
    return (
      <SaveAsDialog
        title={`Save the ${picked.aspect} copy as`}
        copy={picked.copy}
        defaultName={picked.name}
        onClose={onClose}
        onSaved={(name) => useEditor.getState().toast(`Opened the ${picked.aspect} copy "${name}". Layers were scaled to fit — adjust them as you like.`)}
      />
    );
  const base = projectName ?? 'My project';
  return (
    <Modal title="Make a copy in another format" onClose={onClose}>
      <p className="muted small">Layers are scaled to fit the new shape and stay centred. This project isn't changed.</p>
      <div className="format-grid">
        {FORMATS.map((f) => {
          const size = formatSize(project.settings, f.aspect);
          const isCurrent = project.settings.aspect === f.aspect;
          const [aw, ah] = ASPECTS[f.aspect];
          const tag = f.aspect.replace(':', 'x');
          return (
            <button
              key={f.aspect}
              className="format-option"
              disabled={isCurrent}
              data-testid={`format-option-${tag}`}
              title={isCurrent ? 'This project already has this format' : `Make a ${f.label} copy (${size.width}×${size.height}) for ${f.hint}`}
              onClick={() => setPicked({ copy: fitToFrame(project, size.width, size.height), name: `${base} ${tag}`, aspect: f.aspect })}
            >
              <span className="format-shape" style={{ aspectRatio: `${aw} / ${ah}` }} />
              <strong>{f.label}</strong>
              <span className="muted small">{isCurrent ? 'current format' : `${size.width}×${size.height} · ${f.hint}`}</span>
            </button>
          );
        })}
      </div>
      {dirty && (
        <p className="warn small" data-testid="format-copy-unsaved">
          {projectName
            ? `"${projectName}" has unsaved changes: the copy includes them, "${projectName}" itself keeps its last saved version.`
            : "This project hasn't been saved: the copy includes everything. Save it first if you want to keep this version too."}
        </p>
      )}
      <div className="btn-row">
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

interface Job {
  id: string;
  status: string;
  frame: number;
  total: number;
  error?: string;
  /** Problems that didn't stop the export (e.g. a missing audio file). */
  warnings?: string[];
  outFile: string;
  width: number;
  height: number;
}

/** Anything to hear: audio clips or cursor click sounds (muted ones count — the checkbox is about having audio). */
function hasAudio(project: Project): boolean {
  const { clips, skipped } = resolveClips(project);
  return clips.length + skipped.length > 0;
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const [health, setHealth] = useState<{ ffmpeg: boolean; ffmpegHelp: string; workspace: string } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectName = useEditor((s) => s.projectName);
  const project = useEditor((s) => s.project);
  const exportScale = usePrefs((s) => s.exportScale);
  const exportQuality = usePrefs((s) => s.exportQuality);
  const exportAudio = usePrefs((s) => s.exportAudio);
  const setPref = usePrefs((s) => s.setPref);
  const settings = project.settings;
  const audioAvailable = hasAudio(project);
  const quality = QUALITIES[exportQuality];
  const options: ExportOptions = { scale: exportScale, crf: quality.crf, preset: quality.preset, audio: audioAvailable && exportAudio };
  const { outW, outH } = exportSize(settings, exportScale);

  useEffect(() => {
    api<{ ffmpeg: boolean; ffmpegHelp: string; workspace: string }>('/api/health').then(setHealth, (e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!job || ['done', 'error', 'cancelled'].includes(job.status)) return;
    const t = setInterval(async () => {
      try {
        setJob(await api<Job>(`/api/jobs/${job.id}`));
      } catch (e) {
        setError((e as Error).message);
      }
    }, 300);
    return () => clearInterval(t);
  }, [job]);

  const start = async () => {
    setError(null);
    try {
      const { project, projectName: name } = useEditor.getState();
      setJob(await api<Job>('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, name, ...options }) }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const cancel = async () => job && setJob(await api<Job>(`/api/jobs/${job.id}/cancel`, { method: 'POST' }));
  const running = !!job && !['done', 'error', 'cancelled'].includes(job.status);
  const pct = job ? Math.round((100 * job.frame) / Math.max(1, job.total)) : 0;
  const sep = health?.workspace.includes('\\') ? '\\' : '/';
  // The same export from a terminal (CLI flags only where they differ from the defaults).
  const flags = [
    options.scale !== 1 && `--scale ${options.scale}`,
    options.crf !== 16 && `--crf ${options.crf}`,
    options.preset !== 'medium' && `--preset ${options.preset}`,
    audioAvailable && !options.audio && '--no-audio',
  ].filter(Boolean);
  const cliCmd = projectName && health ? [`npm run render -- "${health.workspace}${sep}${projectName}.motion" "${projectName}.mp4"`, ...flags].join(' ') : null;
  const fileHint = `${sanitizeName(projectName ?? '') || 'untitled'}-${outW}x${outH}-‹date›.mp4`;

  return (
    <Modal title="Export MP4" onClose={() => !running && onClose()}>
      <div className="export-options">
        <label className="export-row" title="Pixel size of the video. Smaller sizes export faster and make smaller files — handy for checking timing.">
          <span>Size</span>
          <select value={String(exportScale)} disabled={running} data-testid="export-size" onChange={(e) => setPref({ exportScale: Number(e.target.value) })}>
            {EXPORT_SCALES.map((s) => (
              <option key={s} value={String(s)}>
                {sizeLabel(settings, s)}
              </option>
            ))}
          </select>
        </label>
        <label className="export-row" title="Best keeps every detail (bigger file). Good is smaller and still sharp. Draft is the quickest to make, for checking.">
          <span>Quality</span>
          <select value={exportQuality} disabled={running} data-testid="export-quality" onChange={(e) => setPref({ exportQuality: e.target.value as QualityId })}>
            {(Object.keys(QUALITIES) as QualityId[]).map((q) => (
              <option key={q} value={q}>
                {QUALITIES[q].label}
              </option>
            ))}
          </select>
        </label>
        <label className="export-row export-check" title={audioAvailable ? 'Mix the audio clips and click sounds into the video.' : 'This project has no audio clips (import a sound to add one).'}>
          <span />
          <span>
            <input type="checkbox" checked={options.audio} disabled={!audioAvailable || running} data-testid="export-audio" onChange={(e) => setPref({ exportAudio: e.target.checked })} />
            Include audio
            {!audioAvailable && (
              <span className="muted small" data-testid="export-no-audio">
                {' '}
                — No audio clips
              </span>
            )}
          </span>
        </label>
      </div>
      <p className="muted small" data-testid="export-summary">
        {outW}×{outH}, {settings.fps} fps, {settings.durationSec} s — H.264 MP4 (CRF {options.crf}). File: <code>{fileHint}</code>
      </p>
      {health && !health.ffmpeg && (
        <div className="warn-box" data-testid="ffmpeg-missing">
          <pre>{health.ffmpegHelp}</pre>
          {cliCmd && (
            <p>
              After installing, you can also render from a terminal:
              <br />
              <code>{cliCmd}</code>
            </p>
          )}
          {!cliCmd && <p>Save the project first to get a command-line render command.</p>}
        </div>
      )}
      {error && (
        <div className="warn-box">
          <pre>{error}</pre>
          {cliCmd && (
            <p>
              Command-line render: <code>{cliCmd}</code>
            </p>
          )}
        </div>
      )}
      {job && (
        <div className="progress-wrap">
          <div className="progress">
            <div className="bar" style={{ width: `${pct}%` }} />
          </div>
          <p data-testid="export-status">
            {job.status} — frame {job.frame}/{job.total} ({pct}%)
          </p>
          {job.error && <pre className="warn">{job.error}</pre>}
          {!!job.warnings?.length && (
            <ul className="warn export-warnings" data-testid="export-warnings">
              {job.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {job.status === 'done' && (
            <p>
              Saved to <code data-testid="export-file">{job.outFile}</code>
              <br />
              <a className="button primary" href={`/api/jobs/${job.id}/download`} data-testid="export-download">
                Download MP4
              </a>
            </p>
          )}
        </div>
      )}
      {cliCmd && health?.ffmpeg && (
        <p className="muted small" data-testid="export-cli">
          Same render from a terminal: <code>{cliCmd}</code>
        </p>
      )}
      <div className="btn-row">
        {running ? (
          <button className="danger" onClick={cancel} data-testid="export-cancel">
            Cancel export
          </button>
        ) : (
          <>
            <button onClick={onClose}>Close</button>
            <button className="primary" onClick={start} disabled={!health?.ffmpeg} data-testid="export-start">
              {job ? 'Export again' : 'Start export'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
