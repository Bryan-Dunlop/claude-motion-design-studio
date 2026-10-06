// Pure audio-clip editing rules (no DOM): new-clip defaults, timeline trims/moves, duplicate at the playhead.
import type { Asset, AudioClip, Project } from '../../shared/schema';

/** Keep stored times tidy (drag maths produces values like 0.19999999999999998). */
export const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Clip name from a file name: "Whoosh 02.mp3" → "Whoosh 02". */
export function clipName(originalName: string): string {
  return originalName.replace(/\.[^.]+$/, '') || originalName;
}

/**
 * Defaults for a clip made from `asset` (docs/v2-plan.md B1):
 * - starts at 0 when the file is at least as long as the project (music), otherwise at the playhead (sound effect);
 *   `atPlayhead` always uses the playhead ("+ at playhead");
 * - if the playhead is at the very end, the clip is moved back so it still fits;
 * - length = min(file length, time left in the project); when that cuts the file short it fades out over
 *   min(1.5 s, length/4) so the music doesn't stop abruptly.
 */
export function newClip(asset: Pick<Asset, 'id' | 'originalName' | 'duration'>, project: Pick<Project, 'settings'>, playhead: number, id: string, opts: { atPlayhead?: boolean } = {}): AudioClip {
  const total = project.settings.durationSec;
  const fileLen = asset.duration ?? total;
  let start = !opts.atPlayhead && fileLen >= total ? 0 : Math.min(Math.max(0, playhead), total);
  const minLen = 1 / project.settings.fps;
  if (total - start < minLen) start = Math.max(0, total - Math.min(fileLen, total));
  const duration = Math.max(1e-3, Math.min(fileLen, total - start));
  const shortened = duration < fileLen - 1e-6;
  return {
    id,
    name: clipName(asset.originalName),
    assetId: asset.id,
    start: round6(start),
    trimStart: 0,
    duration: round6(duration),
    volume: 1,
    fadeIn: 0,
    fadeOut: shortened ? round6(Math.min(1.5, duration / 4)) : 0,
    muted: false,
  };
}

/** Move by dt seconds (never before 0). */
export function moveClip(c: Pick<AudioClip, 'start'>, dt: number): Pick<AudioClip, 'start'> {
  return { start: round6(Math.max(0, c.start + dt)) };
}

/** Left edge: start and trimStart move together, the end stays put (can't go before the file start or 0). */
export function trimClipLeft(c: Pick<AudioClip, 'start' | 'trimStart' | 'duration'>, dt: number, minLen: number): Pick<AudioClip, 'start' | 'trimStart' | 'duration'> {
  const lo = -Math.min(c.trimStart, c.start);
  const hi = Math.max(lo, c.duration - minLen);
  const d = Math.min(Math.max(dt, lo), hi);
  return { start: round6(c.start + d), trimStart: round6(c.trimStart + d), duration: round6(c.duration - d) };
}

/** Right edge: changes the length, never past the end of the file. */
export function trimClipRight(c: Pick<AudioClip, 'trimStart' | 'duration'>, dt: number, minLen: number, fileLen?: number): Pick<AudioClip, 'duration'> {
  const max = fileLen === undefined ? Infinity : Math.max(minLen, fileLen - c.trimStart);
  return { duration: round6(Math.min(max, Math.max(minLen, c.duration + dt))) };
}

/** Copies of the clips `ids`, the earliest one at `at`, the others keeping their spacing. */
export function duplicateClipsAt(clips: readonly AudioClip[], ids: readonly string[], at: number, newId: () => string): AudioClip[] {
  const picked = clips.filter((c) => ids.includes(c.id));
  if (picked.length === 0) return [];
  const first = Math.min(...picked.map((c) => c.start));
  return picked.map((c) => ({ ...c, id: newId(), start: round6(Math.max(0, at + c.start - first)) }));
}

/** "0:00", "0:02.5", "1:05.25" — for toasts and labels. */
export function clockLabel(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m}:${String(s).padStart(2, '0')}${c ? `.${String(c).padStart(2, '0').replace(/0$/, '')}` : ''}`;
}
