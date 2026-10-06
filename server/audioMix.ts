// Audio for the MP4 export: one ffmpeg input per audible clip, mixed in a filter graph next to the raw video on stdin.
// The command shape was verified on ffmpeg 6.1.1 (docs/v2-plan.md B1): adelay emits NOPTS timestamps, so the mix is
// re-timed with asetpts=N/SR/TB and padded/cut to the exact video length in samples, which also stops an empty clip
// from hanging the encoder.
import { resolveClips, videoEnd } from '../src/shared/audioPlan';
import type { Asset, Project } from '../src/shared/schema';

export const AUDIO_RATE = 48000;

export interface AudioArgs {
  /** `-i <file>` for every mixed clip, in input order (input 0 is the raw video on stdin). */
  inputs: string[];
  /** `-filter_complex <graph> -map 0:v -map [aout]`, or [] when nothing is audible. */
  filter: string[];
  /** `-c:a aac -b:a 192k -ar 48000`, or [] when nothing is audible. */
  codec: string[];
  /** Human-readable problems (missing files), shown in the export dialog / printed by the CLI. */
  warnings: string[];
}

/** Seconds/milliseconds for filter arguments: at most 6 decimals, no exponent, no trailing zeros. */
export function num(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return (Object.is(r, -0) ? 0 : r).toFixed(6).replace(/\.?0+$/, '');
}

/**
 * Build the audio part of the ffmpeg command. `fileFor` returns the asset's file on disk, or null when it is missing
 * (the clip is skipped with a warning). Clips follow the same skip/clamp rules as the preview (resolveClips).
 */
export function buildAudioArgs(project: Project, fileFor: (asset: Asset) => string | null): AudioArgs {
  const files = new Map<string, string | null>();
  const fileOf = (asset: Asset) => {
    if (!files.has(asset.id)) files.set(asset.id, fileFor(asset));
    return files.get(asset.id) ?? null;
  };
  const { clips, skipped } = resolveClips(project, { isMissing: (a) => !fileOf(a) });

  const warnings: string[] = [];
  for (const assetId of new Set(skipped.filter((s) => s.reason === 'missing').map((s) => s.assetId))) {
    const asset = project.assets.find((a) => a.id === assetId);
    warnings.push(`Audio file missing: ${asset?.originalName ?? assetId} — exported without it.`);
  }
  if (clips.length === 0) return { inputs: [], filter: [], codec: [], warnings };

  const inputs: string[] = [];
  const chains: string[] = [];
  clips.forEach((c, i) => {
    const asset = project.assets.find((a) => a.id === c.assetId)!;
    inputs.push('-i', fileOf(asset)!);
    const f = [
      `atrim=start=${num(c.trimStart)}:duration=${num(c.duration)}`,
      'asetpts=PTS-STARTPTS',
      `aformat=sample_rates=${AUDIO_RATE}:channel_layouts=stereo`,
      `volume=${num(c.volume)}`,
    ];
    // afade d=0 is NOT "no fade" (it falls back to 44100 samples), so a fade is only emitted when it is > 0.
    if (c.fadeIn > 0) f.push(`afade=t=in:st=0:d=${num(c.fadeIn)}`);
    if (c.fadeOut > 0) f.push(`afade=t=out:st=${num(Math.max(0, c.duration - c.fadeOut))}:d=${num(c.fadeOut)}`);
    f.push(`adelay=${num(c.start * 1000)}:all=1`);
    chains.push(`[${i + 1}:a]${f.join(',')}[c${i}]`);
  });
  // The audio length is the VIDEO length (whole frames), not durationSec.
  const ns = Math.round(videoEnd(project) * AUDIO_RATE);
  const mix =
    clips.map((_, i) => `[c${i}]`).join('') +
    `amix=inputs=${clips.length}:normalize=0:duration=longest,asetpts=N/SR/TB,apad=whole_len=${ns},atrim=end_sample=${ns}[aout]`;
  return {
    inputs,
    filter: ['-filter_complex', [...chains, mix].join(';'), '-map', '0:v', '-map', '[aout]'],
    codec: ['-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE)],
    warnings,
  };
}
