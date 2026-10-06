// Export size and options, shared by the Export dialog, the server (POST /api/export), the render page and the CLI.
import { z } from 'zod';
import type { Settings } from './schema';

// Output size for an export at `exportScale` (1 = 100%): even dimensions (libx264 + yuv420p reject odd sizes) and the
// renderFrame scale that fills them (never an unpainted edge; at most a 1 px crop).
export function exportSize(settings: Pick<Settings, 'width' | 'height'>, exportScale = 1): { outW: number; outH: number; scale: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const outW = even(settings.width * exportScale);
  const outH = even(settings.height * exportScale);
  return { outW, outH, scale: Math.max(outW / settings.width, outH / settings.height) };
}

/** Sizes offered in the Export dialog, as fractions of the project size. */
export const EXPORT_SCALES = [1, 0.5, 0.25] as const;

/** libx264 speed presets (faster = bigger file at the same CRF). */
export const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;

/** Export options: the fields next to `project` and `name` in POST /api/export, and the CLI flags. All optional. */
export const ExportOptionsSchema = z.object({
  /** Fraction of the project size, 0 < scale ≤ 1. */
  scale: z.number().gt(0).max(1).default(1),
  /** libx264 constant rate factor: lower = more detail and a bigger file. */
  crf: z.number().int().min(0).max(51).default(16),
  preset: z.enum(X264_PRESETS).default('medium'),
  /** Mix the audio clips (and click sounds) into the video. */
  audio: z.boolean().default(true),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;
export type ExportOptionsInput = z.input<typeof ExportOptionsSchema>;

const OPTION_HELP: Record<string, string> = {
  scale: 'scale must be more than 0 and at most 1 (e.g. 0.5, or 50%)',
  crf: 'crf must be a whole number from 0 (best) to 51 (smallest file)',
  preset: `preset must be one of ${X264_PRESETS.join(', ')}`,
  audio: 'audio must be true or false',
};

/** Validate export options (other keys are ignored). Errors are plain sentences, one per bad option. */
export function parseExportOptions(input: Record<string, unknown>): { ok: true; options: ExportOptions } | { ok: false; error: string } {
  const r = ExportOptionsSchema.safeParse({ scale: input.scale, crf: input.crf, preset: input.preset, audio: input.audio });
  if (r.success) return { ok: true, options: r.data };
  const keys = [...new Set(r.error.issues.map((i) => String(i.path[0])))];
  return { ok: false, error: keys.map((k) => OPTION_HELP[k] ?? `${k} is invalid`).join('; ') };
}

export type QualityId = 'best' | 'good' | 'draft';

/** The Export dialog's Quality choices. */
export const QUALITIES: Record<QualityId, { label: string; crf: number; preset: ExportOptions['preset'] }> = {
  best: { label: 'Best (larger file)', crf: 16, preset: 'medium' },
  good: { label: 'Good', crf: 20, preset: 'medium' },
  draft: { label: 'Draft (fastest)', crf: 26, preset: 'veryfast' },
};

/** Label of a Size choice with its live pixel size, e.g. "50% — 1920×1080 (Full HD)". */
export function sizeLabel(settings: Pick<Settings, 'width' | 'height'>, exportScale: number): string {
  const { outW, outH } = exportSize(settings, exportScale);
  const fullHd = (outW === 1920 && outH === 1080) || (outW === 1080 && outH === 1920);
  const note = fullHd ? ' (Full HD)' : exportScale === 0.25 ? ' (quick check)' : '';
  return `${Math.round(exportScale * 100)}% — ${outW}×${outH}${note}`;
}

/** File name of an exported video: `${name}-${W}x${H}-${stamp}.mp4` (W×H = the output size; no ':' for Windows). */
export function exportFileName(name: string, outW: number, outH: number, date: Date): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${name || 'untitled'}-${outW}x${outH}-${stamp}.mp4`;
}
