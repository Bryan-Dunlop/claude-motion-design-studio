// planAudio / resolveClips: what the preview engine schedules, with exactly the export's skip and clamp rules.
import { describe, expect, it } from 'vitest';
import { buildAudioArgs } from '../../server/audioMix';
import { audioPlanKey, clipGain, fadeInGain, fadeOutGain, planAudio, resolveClips, videoEnd } from '../../src/shared/audioPlan';
import { makeLayer, makeProject, makeScene } from '../../src/shared/factories';
import { emptyProject, type AudioClip, type Project } from '../../src/shared/schema';

function project(clips: Partial<AudioClip>[], durationSec = 4): Project {
  return makeProject({
    ...emptyProject(),
    settings: { durationSec, aspect: '16:9', width: 640, height: 360, fps: 30, background: '#000000' },
    assets: [
      { id: 'a', originalName: 'music.mp3', relativePath: 'assets/a.mp3', type: 'audio', hash: 'h1', duration: 3 },
      { id: 'b', originalName: 'click.wav', relativePath: 'assets/b.wav', type: 'audio', hash: 'h2', duration: 0.25 },
      { id: 'img', originalName: 'logo.png', relativePath: 'assets/logo.png', type: 'image', hash: 'h3', width: 10, height: 10 },
    ],
    audio: clips.map((c, i) => ({ id: `c${i}`, name: `clip ${i}`, assetId: 'a', start: 0, trimStart: 0, duration: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false, ...c })),
  });
}

function cursorScene(sceneStart: number, layer: Record<string, unknown> = {}) {
  return makeScene({
    id: 's1', name: 'Scene', start: sceneStart, duration: 2,
    layers: [
      makeLayer({
        id: 'cur', name: 'Cursor', type: 'cursor', visible: true, locked: false, start: 0.5, duration: 1, anchorX: 0, anchorY: 0, x: 0, y: 0,
        scale: 1, rotation: 0, opacity: 1, keyframes: {}, points: [], smoothing: 0, size: 40, color: '#fff', rippleColor: '#fff6',
        clicks: [{ id: 'k1', time: 0.25 }, { id: 'k2', time: 0.75 }, { id: 'k3', time: 1 }],
        clickSound: { assetId: 'b', volume: 0.5 },
        ...layer,
      } as never),
    ],
  });
}

describe('planAudio', () => {
  it('from 0: each clip waits until its start and plays from its trim point', () => {
    const p = project([{ start: 0.5, trimStart: 0.25, duration: 1 }, { start: 0, duration: 2, volume: 2 }]);
    expect(planAudio(p, 0)).toEqual([
      { id: 'c0', assetId: 'a', start: 0.5, trimStart: 0.25, duration: 1, volume: 1, fadeIn: 0, fadeOut: 0, delay: 0.5, elapsed: 0, offset: 0.25, remaining: 1 },
      { id: 'c1', assetId: 'a', start: 0, trimStart: 0, duration: 2, volume: 2, fadeIn: 0, fadeOut: 0, delay: 0, elapsed: 0, offset: 0, remaining: 2 },
    ]);
  });

  it('from the middle of a clip: starts right away, further into the file, for the rest of its length', () => {
    const [c] = planAudio(project([{ start: 0.5, trimStart: 0.25, duration: 1 }]), 1.1);
    expect(c.delay).toBe(0);
    expect(c.elapsed).toBeCloseTo(0.6, 9);
    expect(c.offset).toBeCloseTo(0.85, 9);
    expect(c.remaining).toBeCloseTo(0.4, 9);
  });

  it('clips that already ended are not scheduled', () => {
    expect(planAudio(project([{ start: 0.5, duration: 1 }]), 1.5)).toEqual([]);
    expect(planAudio(project([{ start: 0.5, duration: 1 }]), 2)).toEqual([]);
  });

  it('skips muted, silent, after-the-end, missing and trimmed-past-the-file clips — like the export', () => {
    const p = project([{ muted: true }, { volume: 0 }, { start: 4 }, { assetId: 'gone' }, { assetId: 'img' }, { trimStart: 3 }, { trimStart: 2.9995 }, { start: 1 }]);
    const r = resolveClips(p);
    expect(r.clips.map((c) => c.id)).toEqual(['c7']);
    expect(r.skipped.map((s) => s.reason)).toEqual(['muted', 'silent', 'after-end', 'missing', 'missing', 'trimmed-past-end', 'trimmed-past-end']);
    expect(planAudio(p, 0).map((c) => c.id)).toEqual(['c7']);
    // A file the caller reports as missing (preview: failed to load; export: not on disk) is skipped too.
    expect(resolveClips(p, { isMissing: (a) => a.id === 'a' }).clips).toEqual([]);
  });

  it('clamps the length to the file and the video end, and the fades to the length', () => {
    const p = project([{ trimStart: 2.5, duration: 2 }, { start: 3.5, duration: 2, fadeIn: 0.25, fadeOut: 9 }]);
    const [a, b] = resolveClips(p).clips;
    expect(a.duration).toBeCloseTo(0.5, 9); // asset 3 s − trimStart 2.5
    expect(b).toMatchObject({ duration: 0.5, fadeIn: 0.25, fadeOut: 0.5 }); // video ends at 4 s
  });

  it('the video end is whole frames (frameCount/fps), not durationSec', () => {
    const p = project([{ start: 1, duration: 5 }], 2.01);
    expect(videoEnd(p)).toBe(2);
    expect(resolveClips(p).clips[0].duration).toBe(1);
  });

  it('uses exactly the clamped values the export mixes (preview == export)', () => {
    const p = project([
      { start: 0.25, trimStart: 0.5, duration: 9, fadeIn: 0.5, fadeOut: 0.75 },
      { start: 3.5, duration: 2, fadeIn: 2, fadeOut: 2, volume: 0.5 },
      { start: 1.2, trimStart: 2.9, duration: 1, fadeOut: 1 },
    ]);
    const graph = buildAudioArgs(p, () => '/f').filter[1];
    const fromExport = [...graph.matchAll(/atrim=start=([\d.]+):duration=([\d.]+).*?volume=([\d.]+)(?:,afade=t=in:st=0:d=([\d.]+))?(?:,afade=t=out:st=([\d.]+):d=([\d.]+))?,adelay=([\d.]+)/g)].map((m) => ({
      trimStart: Number(m[1]),
      duration: Number(m[2]),
      volume: Number(m[3]),
      fadeIn: Number(m[4] ?? 0),
      fadeOut: Number(m[6] ?? 0),
      start: Number(m[7]) / 1000,
    }));
    const fromPlan = planAudio(p, 0).map((c) => ({ trimStart: c.trimStart, duration: c.duration, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, start: c.start }));
    expect(fromExport).toHaveLength(3);
    fromExport.forEach((e, i) => {
      for (const k of Object.keys(e) as (keyof typeof e)[]) expect(fromPlan[i][k]).toBeCloseTo(e[k], 6);
    });
  });

  it('gain envelope: linear fades that multiply, like two afade filters', () => {
    const c = { volume: 2, fadeIn: 0.5, fadeOut: 1, duration: 2 };
    expect(clipGain(c, 0)).toBe(0);
    expect(clipGain(c, 0.25)).toBeCloseTo(1, 9);
    expect(clipGain(c, 0.5)).toBe(2);
    expect(clipGain(c, 1)).toBe(2);
    expect(clipGain(c, 1.5)).toBeCloseTo(1, 9);
    expect(clipGain(c, 2)).toBe(0);
    // Overlapping fades on a short clip: in(u) × out(u).
    const short = { volume: 1, fadeIn: 1, fadeOut: 1, duration: 1 };
    expect(fadeInGain(short, 0.5) * fadeOutGain(short, 0.5)).toBeCloseTo(0.25, 9);
    expect(clipGain(short, 0.5)).toBeCloseTo(0.25, 9);
    expect(clipGain({ volume: 1, fadeIn: 0, fadeOut: 0, duration: 1 }, 0)).toBe(1);
  });
});

describe('click sounds (virtual clips)', () => {
  it('one clip per click at scene.start + layer.start + click.time; clicks outside the layer are skipped', () => {
    const p = project([], 6);
    p.scenes.push(cursorScene(2));
    const clips = resolveClips(p).clips;
    // Layer 0.5..1.5 in a scene starting at 2: clicks at 0.25 and 0.75 → 2.75 s and 3.25 s; t=1 is at the layer's end.
    expect(clips.map((c) => [c.id, c.start, c.duration, c.volume, c.trimStart])).toEqual([
      ['click:cur:k1', 2.75, 0.25, 0.5, 0],
      ['click:cur:k2', 3.25, 0.25, 0.5, 0],
    ]);
  });

  it('clicks past the scene end are skipped; hidden cursors and cursors without a sound are silent', () => {
    const p = project([], 6);
    p.scenes.push(cursorScene(0, { start: 1.5, duration: 2 }));
    // Scene lasts 2 s: layer starts at 1.5, so only the click at 0.25 (1.75 s) is inside the scene.
    expect(resolveClips(p).clips.map((c) => c.start)).toEqual([1.75]);
    p.scenes[0].layers[0].visible = false;
    expect(resolveClips(p).clips).toEqual([]);
    const q = project([], 6);
    q.scenes.push(cursorScene(0, { clickSound: null }));
    expect(resolveClips(q).clips).toEqual([]);
  });

  it('follow the cursor: moving the layer moves the sounds; moving other layers changes nothing', () => {
    const p = project([{ start: 0.5 }], 6);
    p.scenes.push(cursorScene(0));
    const key = audioPlanKey(p);
    const moved = structuredClone(p);
    moved.scenes[0].layers[0].start = 0.75;
    expect(audioPlanKey(moved)).not.toBe(key);
    const unrelated = structuredClone(p);
    unrelated.scenes[0].layers[0].x = 500;
    unrelated.settings.background = '#ffffff';
    expect(audioPlanKey(unrelated)).toBe(key);
    const louder = structuredClone(p);
    louder.audio[0].volume = 0.5;
    expect(audioPlanKey(louder)).not.toBe(key);
  });
});
