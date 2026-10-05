import { useEffect, useState } from 'react';
import { api, listProjects, openProject, saveProject } from '../actions';
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

export function SaveAsDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(useEditor.getState().projectName ?? 'My project');
  const [existing, setExisting] = useState<string[]>([]);
  useEffect(() => {
    listProjects().then((l) => setExisting(l.map((p) => p.name)), () => undefined);
  }, []);
  const clean = name.replace(/[^\w\- ]+/g, '').trim();
  const clash = existing.includes(clean) && clean !== useEditor.getState().projectName;
  return (
    <Modal title="Save project as" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!clean) return;
          if (clash && !confirm(`${clean}.motion already exists. Overwrite it?`)) return;
          if (await saveProject(clean)) onClose();
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

interface Job {
  id: string;
  status: string;
  frame: number;
  total: number;
  error?: string;
  outFile: string;
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const [health, setHealth] = useState<{ ffmpeg: boolean; ffmpegHelp: string; workspace: string } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectName = useEditor((s) => s.projectName);
  const settings = useEditor((s) => s.project.settings);

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
      setJob(await api<Job>('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, name }) }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const cancel = async () => job && setJob(await api<Job>(`/api/jobs/${job.id}/cancel`, { method: 'POST' }));
  const running = job && !['done', 'error', 'cancelled'].includes(job.status);
  const pct = job ? Math.round((100 * job.frame) / Math.max(1, job.total)) : 0;
  const sep = health?.workspace.includes('\\') ? '\\' : '/';
  const cliCmd = projectName && health ? `npm run render -- "${health.workspace}${sep}${projectName}.motion" "${projectName}.mp4"` : null;

  return (
    <Modal title="Export MP4" onClose={() => !running && onClose()}>
      <p>
        {settings.width}×{settings.height}, {settings.fps} fps, {settings.durationSec}s — H.264 (libx264, CRF 16, yuv420p).
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
          {job.status === 'done' && (
            <p>
              Saved to <code>{job.outFile}</code>
              <br />
              <a className="button primary" href={`/api/jobs/${job.id}/download`} data-testid="export-download">
                Download MP4
              </a>
            </p>
          )}
        </div>
      )}
      {cliCmd && health?.ffmpeg && <p className="muted small">Same render from a terminal: <code>{cliCmd}</code></p>}
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
