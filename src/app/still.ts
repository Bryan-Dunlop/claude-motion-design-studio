// "PNG" button: the current frame as an image at full project size, drawn by renderFrame on a createRenderCanvas
// canvas (the export's canvas settings, so text antialiasing matches the video) at the frame's exact time.
import { assetUrl } from '../shared/assetUrl';
import { createCanvasPool, createRenderCanvas } from '../shared/canvas';
import { loadResources } from '../shared/loadResources';
import { frameCount, renderFrame, type RenderResources } from '../shared/renderFrame';
import type { Project } from '../shared/schema';
import { useEditor } from './store';

/** The frame under the playhead (what the playback bar shows as "frame n"). */
export function frameAt(project: Project, time: number): number {
  return Math.min(frameCount(project) - 1, Math.floor(time * project.settings.fps + 1e-6));
}

/** `${name}-${W}x${H}-frame${n}.png` (an unsaved project is "untitled", like its MP4). */
export function stillFileName(name: string | null, project: Project, frame: number): string {
  return `${name || 'untitled'}-${project.settings.width}x${project.settings.height}-frame${frame}.png`;
}

/** Render frame `frame` of `project` at full size and encode it as PNG. */
export async function renderStill(project: Project, frame: number, resources: RenderResources): Promise<Blob> {
  const { width, height, fps } = project.settings;
  const { canvas, ctx } = createRenderCanvas(width, height);
  renderFrame(project, frame / fps, ctx, 1, { ...resources, canvasPool: createCanvasPool() });
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the PNG'))), 'image/png'));
}

/** Save the frame under the playhead as a PNG file (a browser download). */
export async function downloadStill() {
  const { project, projectName, time, toast } = useEditor.getState();
  const frame = frameAt(project, time);
  try {
    // Loaded like the render page does (cached, so instant once the preview has them; fonts in use are awaited).
    const { missing: _missing, ...resources } = await loadResources(project, (id) => assetUrl(projectName, project.assets.find((a) => a.id === id)!));
    const blob = await renderStill(project, frame, resources);
    const name = stillFileName(projectName, project, frame);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast(`Saved frame ${frame} as ${name}`);
  } catch (e) {
    toast(`PNG failed: ${(e as Error).message}`, 'error');
  }
}
