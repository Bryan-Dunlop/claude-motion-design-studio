// Render-only page (no editor UI). Used by headless Chromium for export, and by tests.
import '../shared/fonts';
import { assetUrl } from '../shared/assetUrl';
import { loadResources } from '../shared/loadResources';
import { frameCount, frameTime, renderFrame } from '../shared/renderFrame';
import { ProjectSchema, type Project } from '../shared/schema';

const params = new URLSearchParams(location.search);
const jobId = params.get('job');

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false })!;
  return { canvas, ctx };
}

async function runJob(id: string) {
  const status = document.createElement('div');
  document.body.appendChild(status);
  try {
    const { project } = (await (await fetch(`/api/jobs/${id}/project`)).json()) as { project: Project };
    const res = await loadResources(project, (assetId) => `/api/jobs/${id}/asset/${assetId}`);
    const { width, height } = project.settings;
    const { canvas, ctx } = makeCanvas(width, height);
    canvas.style.display = 'none';
    const total = frameCount(project);
    // Frames are uploaded strictly in order; the next frame renders while the previous one uploads.
    // (A Blob body is ~10x faster to send than a typed array in Chromium.)
    let pending: Promise<Response> | null = null;
    for (let i = 0; i < total; i++) {
      renderFrame(project, frameTime(project, i), ctx, 1, res);
      const body = new Blob([ctx.getImageData(0, 0, width, height).data]);
      if (pending && !(await pending).ok) return; // cancelled or failed server-side
      pending = fetch(`/api/jobs/${id}/frame/${i}`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (pending && !(await pending).ok) return;
    await fetch(`/api/jobs/${id}/done`, { method: 'POST' });
  } catch (e) {
    await fetch(`/api/jobs/${id}/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: (e as Error).message }),
    });
  }
}

/** Test/automation API: render a project at time t and return pixels. */
const api = {
  async render(projectJson: unknown, t: number, opts: { projectName?: string; scale?: number } = {}) {
    const project = ProjectSchema.parse(projectJson);
    const res = await loadResources(project, (assetId) => assetUrl(opts.projectName ?? null, project.assets.find((a) => a.id === assetId)!));
    const scale = opts.scale ?? 1;
    const w = Math.round(project.settings.width * scale);
    const h = Math.round(project.settings.height * scale);
    const { canvas, ctx } = makeCanvas(w, h);
    renderFrame(project, t, ctx, scale, res);
    const data = ctx.getImageData(0, 0, w, h).data;
    const hash = await crypto.subtle.digest('SHA-256', data);
    const png = canvas.toDataURL('image/png');
    canvas.remove();
    return { width: w, height: h, sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join(''), png };
  },
};
(window as unknown as { motion: typeof api }).motion = api;

if (jobId) void runJob(jobId);
else document.title = 'render-ready';
