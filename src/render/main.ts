// Render-only page (no editor UI). Used by headless Chromium for export, and by tests.
import '../shared/fonts';
import { assetUrl } from '../shared/assetUrl';
import { createCanvasPool, RENDER_CONTEXT_OPTIONS } from '../shared/canvas';
import { exportSize } from '../shared/exportSize';
import { loadResources } from '../shared/loadResources';
import { frameCount, frameTime, renderFrame } from '../shared/renderFrame';
import { ProjectSchema, type Project } from '../shared/schema';

const params = new URLSearchParams(location.search);
const canvasPool = createCanvasPool();
const jobId = params.get('job');

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  document.body.appendChild(canvas);
  // Same context options as every other render canvas (see src/shared/canvas.ts).
  const ctx = canvas.getContext('2d', RENDER_CONTEXT_OPTIONS)!;
  return { canvas, ctx };
}

async function runJob(id: string) {
  const status = document.createElement('div');
  document.body.appendChild(status);
  try {
    // The output size and the scale that fills it come from the server (exportSize), so ffmpeg gets exactly these bytes.
    const job = (await (await fetch(`/api/jobs/${id}/project`)).json()) as { project: Project; outW: number; outH: number; scale: number };
    const { project, outW, outH, scale } = job;
    const res = { ...(await loadResources(project, (assetId) => `/api/jobs/${id}/asset/${assetId}`)), canvasPool };
    if (res.missing.size) {
      await fetch(`/api/jobs/${id}/missing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: [...res.missing] }) });
    }
    const { canvas, ctx } = makeCanvas(outW, outH);
    canvas.style.display = 'none';
    const total = frameCount(project);
    // Frames are uploaded strictly in order; the next frame renders while the previous one uploads.
    // (A Blob body is ~10x faster to send than a typed array in Chromium.)
    let pending: Promise<Response> | null = null;
    for (let i = 0; i < total; i++) {
      renderFrame(project, frameTime(project, i), ctx, scale, res);
      const body = new Blob([ctx.getImageData(0, 0, outW, outH).data]);
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

/**
 * Test/automation API: render a project at time t and return pixels. `exportScale` renders exactly like an export at
 * that size (exportSize: even output size, fill scale); `scale` is a plain render scale (size rounded).
 */
const api = {
  async render(projectJson: unknown, t: number, opts: { projectName?: string; scale?: number; exportScale?: number } = {}) {
    const project = ProjectSchema.parse(projectJson);
    const res = { ...(await loadResources(project, (assetId) => assetUrl(opts.projectName ?? null, project.assets.find((a) => a.id === assetId)!))), canvasPool };
    const out = opts.exportScale !== undefined ? exportSize(project.settings, opts.exportScale) : null;
    const scale = out?.scale ?? opts.scale ?? 1;
    const w = out?.outW ?? Math.round(project.settings.width * scale);
    const h = out?.outH ?? Math.round(project.settings.height * scale);
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
