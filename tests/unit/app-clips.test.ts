// New-clip defaults and the timeline's clip editing rules (src/app/audio/clips.ts).
import { describe, expect, it } from 'vitest';
import { clipName, clockLabel, duplicateClipsAt, moveClip, newClip, trimClipLeft, trimClipRight } from '../../src/app/audio/clips';
import type { AudioClip } from '../../src/shared/schema';

const project = (durationSec = 15, fps = 30) => ({ settings: { durationSec, fps, aspect: '16:9' as const, width: 1920, height: 1080, background: '#000' } });
const asset = (duration: number, originalName = 'sound.mp3') => ({ id: 'a1', originalName, duration });

describe('new clip defaults', () => {
  it('music (at least as long as the project) starts at 0 whatever the playhead, cut to fit, with a fade-out', () => {
    expect(newClip(asset(30, 'music.mp3'), project(15), 6, 'c1')).toEqual({
      id: 'c1', name: 'music', assetId: 'a1', start: 0, trimStart: 0, duration: 15, volume: 1, fadeIn: 0, fadeOut: 1.5, muted: false,
    });
    // Fade-out = min(1.5, length/4).
    expect(newClip(asset(5), project(4), 0, 'c').fadeOut).toBe(1);
  });

  it('a file exactly as long as the project is music too, and is not shortened (no fade)', () => {
    expect(newClip(asset(15), project(15), 3, 'c')).toMatchObject({ start: 0, duration: 15, fadeOut: 0 });
  });

  it('a sound effect (shorter than the project) goes to the playhead at full length', () => {
    expect(newClip(asset(0.4, 'click.wav'), project(15), 2.5, 'c')).toMatchObject({ name: 'click', start: 2.5, trimStart: 0, duration: 0.4, fadeOut: 0, fadeIn: 0, volume: 1 });
  });

  it('a sound effect near the end is shortened to the time left and fades out over a quarter of it', () => {
    expect(newClip(asset(3), project(15), 14, 'c')).toMatchObject({ start: 14, duration: 1, fadeOut: 0.25 });
  });

  it('with the playhead at the very end, the clip moves back so it still fits', () => {
    expect(newClip(asset(3), project(15), 15, 'c')).toMatchObject({ start: 12, duration: 3, fadeOut: 0 });
    expect(newClip(asset(30), project(15), 15, 'c', { atPlayhead: true })).toMatchObject({ start: 0, duration: 15, fadeOut: 1.5 });
  });

  it('"+ at playhead" puts even long music at the playhead', () => {
    expect(newClip(asset(30), project(15), 5, 'c', { atPlayhead: true })).toMatchObject({ start: 5, duration: 10, fadeOut: 1.5 });
  });

  it('names drop the extension', () => {
    expect([clipName('Whoosh 02.mp3'), clipName('a.b.wav'), clipName('noext')]).toEqual(['Whoosh 02', 'a.b', 'noext']);
  });
});

describe('timeline clip edits', () => {
  const c: AudioClip = { id: 'c', name: 'c', assetId: 'a', start: 2, trimStart: 1, duration: 3, volume: 1, fadeIn: 0, fadeOut: 0, muted: false };
  const minLen = 1 / 30;

  it('move never goes before 0', () => {
    expect(moveClip(c, 1.5)).toEqual({ start: 3.5 });
    expect(moveClip(c, -5)).toEqual({ start: 0 });
  });

  it('left edge: start and skip-into-file move together, the end stays', () => {
    expect(trimClipLeft(c, 0.5, minLen)).toEqual({ start: 2.5, trimStart: 1.5, duration: 2.5 });
    expect(trimClipLeft(c, -0.5, minLen)).toEqual({ start: 1.5, trimStart: 0.5, duration: 3.5 });
    // Not before the start of the file…
    expect(trimClipLeft(c, -1.7, minLen)).toEqual({ start: 1, trimStart: 0, duration: 4 });
    // …nor before 0 on the timeline…
    expect(trimClipLeft({ ...c, start: 0.25 }, -1, minLen)).toEqual({ start: 0, trimStart: 0.75, duration: 3.25 });
    // …nor past the end (keeps at least one frame).
    const r = trimClipLeft(c, 10, minLen);
    expect(r.start + r.duration).toBeCloseTo(5, 6);
    expect(r.duration).toBeCloseTo(minLen, 6);
  });

  it('right edge: length changes, at least one frame, at most the rest of the file', () => {
    expect(trimClipRight(c, -1, minLen, 10)).toEqual({ duration: 2 });
    expect(trimClipRight(c, 20, minLen, 10)).toEqual({ duration: 9 });
    expect(trimClipRight(c, -20, minLen, 10).duration).toBeCloseTo(minLen, 6);
    expect(trimClipRight(c, 20, minLen)).toEqual({ duration: 23 }); // unknown file length: no upper limit
  });

  it('results are tidy (no 0.19999999999999998)', () => {
    expect(trimClipLeft({ ...c, start: 0.3, trimStart: 0.1 }, -0.1, minLen)).toEqual({ start: 0.2, trimStart: 0, duration: 3.1 });
  });

  it('duplicate at the playhead keeps the spacing between several clips', () => {
    const clips: AudioClip[] = [c, { ...c, id: 'd', start: 3.5 }, { ...c, id: 'e', start: 9 }];
    let n = 0;
    const copies = duplicateClipsAt(clips, ['d', 'c'], 10, () => `new${++n}`);
    expect(copies.map((x) => [x.id, x.start, x.duration, x.trimStart])).toEqual([
      ['new1', 10, 3, 1],
      ['new2', 11.5, 3, 1],
    ]);
    expect(duplicateClipsAt(clips, [], 10, () => 'x')).toEqual([]);
  });

  it('clock labels for toasts', () => {
    expect([clockLabel(0), clockLabel(2.5), clockLabel(14.8), clockLabel(65.25), clockLabel(59.999)]).toEqual(['0:00', '0:02.5', '0:14.8', '1:05.25', '1:00']);
  });
});
