// Audio timeline maths shared by the preview engine (Web Audio) and the MP4 export (ffmpeg, server/audioMix.ts).
// Both go through resolveClips, so what you hear in the editor is what gets mixed into the video:
// same skip rules, same clamping of length and fades, same click-sound expansion.
import { frameCount } from './renderFrame';
import type { Asset, Project } from './schema';

/** A clip after the skip and clamp rules: everything needed to play or mix it. */
export interface ResolvedClip {
  /** project.audio id, or `click:<layerId>:<clickId>` for a cursor click sound (a virtual clip, never stored). */
  id: string;
  assetId: string;
  /** Project time where the clip starts (s). */
  start: number;
  /** Seconds skipped at the beginning of the file. */
  trimStart: number;
  /** DUR = min(duration, asset − trimStart, videoEnd − start). */
  duration: number;
  /** Linear gain (1 = original level). */
  volume: number;
  /** FI = min(fadeIn, DUR). 0 = no fade. */
  fadeIn: number;
  /** FO = min(fadeOut, DUR). 0 = no fade. */
  fadeOut: number;
}

export type SkipReason = 'muted' | 'silent' | 'after-end' | 'missing' | 'trimmed-past-end';

export interface SkippedClip {
  id: string;
  assetId: string;
  reason: SkipReason;
}

export interface ResolveOptions {
  /** True when the asset's file can't be found (export: not on disk; preview: failed to load). */
  isMissing?: (asset: Asset) => boolean;
}

/** Length of the exported video: whole frames, so audio is padded/cut to exactly the picture length. */
export function videoEnd(project: Project): number {
  return frameCount(project) / project.settings.fps;
}

interface RawClip {
  id: string;
  assetId: string;
  start: number;
  trimStart: number;
  duration: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  muted: boolean;
}

/**
 * Stored clips plus one virtual clip per click of every visible cursor layer that has a click sound, at
 * `scene.start + layer.start + click.time`. Clicks outside the layer's or the scene's time range are skipped (they are
 * not drawn either), so click sounds follow the clicks through moves, duplication, paste and undo.
 */
function rawClips(project: Project): RawClip[] {
  const out: RawClip[] = project.audio.map((c) => ({ ...c }));
  for (const scene of project.scenes) {
    for (const layer of scene.layers) {
      if (layer.type !== 'cursor' || !layer.visible || !layer.clickSound) continue;
      const sound = layer.clickSound;
      const asset = project.assets.find((a) => a.id === sound.assetId);
      for (const click of [...layer.clicks].sort((a, b) => a.time - b.time)) {
        if (click.time >= layer.duration || layer.start + click.time >= scene.duration) continue;
        out.push({
          id: `click:${layer.id}:${click.id}`,
          assetId: sound.assetId,
          start: scene.start + layer.start + click.time,
          trimStart: 0,
          duration: asset?.duration ?? Infinity,
          volume: sound.volume,
          fadeIn: 0,
          fadeOut: 0,
          muted: false,
        });
      }
    }
  }
  return out;
}

/**
 * Apply the skip and clamp rules (the export's rules, see docs/v2-plan.md B1):
 * skip when muted, volume 0, starting at/after the video end, file missing, or trimmed past the end of the file;
 * DUR = min(duration, asset − trimStart, videoEnd − start), FI = min(fadeIn, DUR), FO = min(fadeOut, DUR).
 */
export function resolveClips(project: Project, opts: ResolveOptions = {}): { clips: ResolvedClip[]; skipped: SkippedClip[] } {
  const end = videoEnd(project);
  const clips: ResolvedClip[] = [];
  const skipped: SkippedClip[] = [];
  for (const c of rawClips(project)) {
    const skip = (reason: SkipReason) => skipped.push({ id: c.id, assetId: c.assetId, reason });
    const asset = project.assets.find((a) => a.id === c.assetId && a.type === 'audio');
    if (c.muted) skip('muted');
    else if (!(c.volume > 0)) skip('silent');
    else if (c.start >= end) skip('after-end');
    else if (!asset || opts.isMissing?.(asset)) skip('missing');
    else if (asset.duration !== undefined && c.trimStart >= asset.duration - 1e-3) skip('trimmed-past-end');
    else {
      const fileLeft = asset.duration !== undefined ? asset.duration - c.trimStart : Infinity;
      const duration = Math.min(c.duration, fileLeft, end - c.start);
      if (!(duration > 1e-6)) {
        skip('trimmed-past-end');
        continue;
      }
      clips.push({
        id: c.id,
        assetId: c.assetId,
        start: c.start,
        trimStart: c.trimStart,
        duration,
        volume: c.volume,
        fadeIn: Math.min(c.fadeIn, duration),
        fadeOut: Math.min(c.fadeOut, duration),
      });
    }
  }
  return { clips, skipped };
}

/** Fade-in factor at clip-local time u (linear, like ffmpeg's afade default curve). */
export function fadeInGain(clip: Pick<ResolvedClip, 'fadeIn'>, u: number): number {
  if (clip.fadeIn <= 0) return 1;
  return Math.min(1, Math.max(0, u / clip.fadeIn));
}

/** Fade-out factor at clip-local time u: 1 until DUR − FO, then linear down to 0 at DUR. */
export function fadeOutGain(clip: Pick<ResolvedClip, 'fadeOut' | 'duration'>, u: number): number {
  if (clip.fadeOut <= 0) return 1;
  const os = Math.max(0, clip.duration - clip.fadeOut);
  return Math.min(1, Math.max(0, (clip.duration - u) / (clip.duration - os)));
}

/** Gain at clip-local time u: volume × fade in × fade out (the fades multiply, like two afade filters in a row). */
export function clipGain(clip: Pick<ResolvedClip, 'volume' | 'fadeIn' | 'fadeOut' | 'duration'>, u: number): number {
  return clip.volume * fadeInGain(clip, u) * fadeOutGain(clip, u);
}

/** A resolved clip as seen from a playback start time. */
export interface PlannedClip extends ResolvedClip {
  /** Seconds from `fromTime` until the clip starts (0 when it is already playing). */
  delay: number;
  /** Seconds of the clip already past at `fromTime` (0 when it starts later). */
  elapsed: number;
  /** Where in the file playback begins: trimStart + elapsed. */
  offset: number;
  /** Seconds left to play: DUR − elapsed. */
  remaining: number;
}

/**
 * What to play when playback starts at `fromTime`: every audible clip that hasn't finished yet, with its delay, file
 * offset and remaining length. Same rules as the export (resolveClips).
 */
export function planAudio(project: Project, fromTime: number, opts: ResolveOptions = {}): PlannedClip[] {
  const out: PlannedClip[] = [];
  for (const c of resolveClips(project, opts).clips) {
    const elapsed = Math.max(0, fromTime - c.start);
    const remaining = c.duration - elapsed;
    if (remaining <= 1e-6) continue;
    out.push({ ...c, delay: Math.max(0, c.start - fromTime), elapsed, offset: c.trimStart + elapsed, remaining });
  }
  return out;
}

/** Stable identity of everything audible: equal keys mean an edit didn't change what is heard (no restart needed). */
export function audioPlanKey(project: Project, opts: ResolveOptions = {}): string {
  return JSON.stringify(resolveClips(project, opts).clips);
}

