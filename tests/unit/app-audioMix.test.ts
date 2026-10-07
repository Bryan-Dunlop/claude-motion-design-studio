// buildAudioArgs: the exact ffmpeg audio command (verified on ffmpeg 6.1.1, docs/v2-plan.md B1) and its skip/clamp rules.
import { describe, expect, it } from 'vitest';
import { buildAudioArgs, num, SHARED_INPUT_SECONDS } from '../../server/audioMix';
import { ffmpegArgs } from '../../server/exporter';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { emptyProject, type AudioClip, type Project } from '../../src/shared/schema';

const CH = 'asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo';

function project(clips: Partial<AudioClip>[], settings: Partial<Project['settings']> = {}): Project {
  return makeProject({
    ...emptyProject(),
    settings: { durationSec: 3, aspect: '16:9', width: 640, height: 360, fps: 30, background: '#000000', ...settings },
    assets: [
      { id: 'a', originalName: 'music.mp3', relativePath: 'assets/a-music.mp3', type: 'audio', hash: 'h1', duration: 10 },
      { id: 'b', originalName: 'click.wav', relativePath: 'assets/b-click.wav', type: 'audio', hash: 'h2', duration: 2 },
    ],
    audio: clips.map((c, i) => ({ id: `c${i}`, name: `clip ${i}`, assetId: 'a', start: 0, trimStart: 0, duration: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false, ...c })),
  });
}

const files: Record<string, string> = { a: '/p/assets/a-music.mp3', b: '/p/assets/b-click.wav' };
const build = (p: Project, missing: string[] = []) => buildAudioArgs(p, (a) => (missing.includes(a.id) ? null : files[a.id]));
/** The filter graph alone. */
const graph = (p: Project) => build(p).filter[1];
const mixTail = (ns: number, n = 1) => `amix=inputs=${n}:normalize=0:duration=longest,asetpts=N/SR/TB,apad=whole_len=${ns},atrim=end_sample=${ns}[aout]`;

describe('buildAudioArgs', () => {
  const cases: { name: string; clips: Partial<AudioClip>[]; settings?: Partial<Project['settings']>; graph: string | null }[] = [
    {
      name: 'single clip at 0 (no fades → no afade, amix with one input)',
      clips: [{}],
      graph: `[1:a]atrim=start=0:duration=1,${CH},volume=1,adelay=0:all=1[c0];[c0]${mixTail(144000)}`,
    },
    {
      name: 'placed, trimmed, quieter',
      clips: [{ start: 0.5, trimStart: 1.25, duration: 1, volume: 0.5 }],
      graph: `[1:a]atrim=start=1.25:duration=1,${CH},volume=0.5,adelay=500:all=1[c0];[c0]${mixTail(144000)}`,
    },
    { name: 'clip starting at the end → skipped (no audio stream)', clips: [{ start: 3 }], graph: null },
    { name: 'clip after the end → skipped', clips: [{ start: 7.5 }], graph: null },
    { name: 'trimStart ≥ file length → skipped', clips: [{ trimStart: 10 }], graph: null },
    { name: 'trimStart within 1 ms of the file end → skipped', clips: [{ trimStart: 9.9995 }], graph: null },
    { name: 'muted → skipped', clips: [{ muted: true }], graph: null },
    { name: 'volume 0 → skipped', clips: [{ volume: 0 }], graph: null },
    {
      name: 'fades longer than the clip are clamped to its length',
      clips: [{ duration: 1, fadeIn: 5, fadeOut: 3 }],
      graph: `[1:a]atrim=start=0:duration=1,${CH},volume=1,afade=t=in:st=0:d=1,afade=t=out:st=0:d=1,adelay=0:all=1[c0];[c0]${mixTail(144000)}`,
    },
    {
      name: 'fade in and out inside the clip',
      clips: [{ start: 1, duration: 1.5, fadeIn: 0.25, fadeOut: 0.5 }],
      graph: `[1:a]atrim=start=0:duration=1.5,${CH},volume=1,afade=t=in:st=0:d=0.25,afade=t=out:st=1:d=0.5,adelay=1000:all=1[c0];[c0]${mixTail(144000)}`,
    },
    {
      name: 'clip running past the video end is cut at the end (DUR = end − start), fade-out ends there',
      clips: [{ start: 2, duration: 5, fadeOut: 0.5 }],
      graph: `[1:a]atrim=start=0:duration=1,${CH},volume=1,afade=t=out:st=0.5:d=0.5,adelay=2000:all=1[c0];[c0]${mixTail(144000)}`,
    },
    {
      name: 'clip longer than the rest of the file is cut at the file end (DUR = asset − trimStart)',
      clips: [{ trimStart: 9.5, duration: 2 }],
      graph: `[1:a]atrim=start=9.5:duration=0.5,${CH},volume=1,adelay=0:all=1[c0];[c0]${mixTail(144000)}`,
    },
    {
      name: 'non-integer durationSec·fps → audio padded to frameCount/fps (60 frames = 2 s), not durationSec',
      clips: [{}],
      settings: { durationSec: 2.01 },
      graph: `[1:a]atrim=start=0:duration=1,${CH},volume=1,adelay=0:all=1[c0];[c0]${mixTail(96000)}`,
    },
    {
      name: 'fractional start in milliseconds (frame 31 at 30 fps)',
      clips: [{ start: 31 / 30, duration: 0.5 }],
      graph: `[1:a]atrim=start=0:duration=0.5,${CH},volume=1,adelay=1033.333333:all=1[c0];[c0]${mixTail(144000)}`,
    },
    {
      name: 'two clips → one input each, mixed in order; skipped ones leave no gap in the numbering',
      clips: [{ start: 0.5 }, { muted: true }, { assetId: 'b', start: 1, volume: 2 }],
      graph:
        `[1:a]atrim=start=0:duration=1,${CH},volume=1,adelay=500:all=1[c0];` +
        `[2:a]atrim=start=0:duration=1,${CH},volume=2,adelay=1000:all=1[c1];[c0][c1]${mixTail(144000, 2)}`,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const p = project(c.clips, c.settings);
      const r = build(p);
      if (c.graph === null) {
        expect(r).toEqual({ inputs: [], filter: [], codec: [], warnings: [] });
        return;
      }
      expect(r.filter).toEqual(['-filter_complex', c.graph, '-map', '0:v', '-map', '[aout]']);
      expect(r.codec).toEqual(['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']);
      expect(r.warnings).toEqual([]);
      // `d=0` is not "no fade" in ffmpeg (it means 44100 samples), so it must never be emitted.
      expect(c.graph).not.toMatch(/d=0[,[]/);
    });
  }

  it('one -i per audible file, in order of first use', () => {
    const r = build(project([{ start: 0.5 }, { muted: true }, { assetId: 'b', start: 1 }]));
    expect(r.inputs).toEqual(['-i', files.a, '-i', files.b]);
  });

  it('clips of the same file share its input through asplit; each keeps its own chain and place in the mix', () => {
    const r = build(project([{ start: 0.5 }, { assetId: 'b', start: 1 }, { start: 2, trimStart: 3, volume: 0.5 }]));
    expect(r.inputs).toEqual(['-i', files.a, '-i', files.b]);
    expect(r.filter[1]).toBe(
      `[1:a]asplit=2[a0][a2];[a0]atrim=start=0:duration=1,${CH},volume=1,adelay=500:all=1[c0];` +
        `[2:a]atrim=start=0:duration=1,${CH},volume=1,adelay=1000:all=1[c1];` +
        `[a2]atrim=start=3:duration=1,${CH},volume=0.5,adelay=2000:all=1[c2];[c0][c1][c2]${mixTail(144000, 3)}`,
    );
  });

  it('long clips keep an input of their own: a shared input carries at most SHARED_INPUT_SECONDS of clips', () => {
    expect(SHARED_INPUT_SECONDS).toBe(10);
    const p = project([{ duration: 40 }, { start: 50, duration: 6 }, { start: 60, duration: 3 }, { start: 70, duration: 2 }], { durationSec: 200 });
    p.assets[0].duration = 100;
    const r = build(p);
    // The 40 s clip (music) shares with nothing; 6 s + 3 s share an input; 2 s more would make 11 s, so a third input.
    expect(r.inputs).toEqual(['-i', files.a, '-i', files.a, '-i', files.a]);
    expect(r.filter[1]).toBe(
      `[1:a]atrim=start=0:duration=40,${CH},volume=1,adelay=0:all=1[c0];` +
        `[2:a]asplit=2[a1][a2];[a1]atrim=start=0:duration=6,${CH},volume=1,adelay=50000:all=1[c1];` +
        `[a2]atrim=start=0:duration=3,${CH},volume=1,adelay=60000:all=1[c2];` +
        `[3:a]atrim=start=0:duration=2,${CH},volume=1,adelay=70000:all=1[c3];[c0][c1][c2][c3]${mixTail(9600000, 4)}`,
    );
  });

  it('1200 click sounds of one cursor share four inputs (the command line has a length limit)', () => {
    const p = project([], { durationSec: 120 });
    p.assets.push({ id: 'tick', originalName: 'tick.wav', relativePath: 'assets/t-tick.wav', type: 'audio', hash: 'h3', duration: 0.03 });
    const clicks = Array.from({ length: 1200 }, (_, i) => ({ id: `k${i}`, time: (i + 0.5) * 0.1 }));
    const cursor = makeLayer({
      id: 'cur', name: 'Cursor', type: 'cursor', visible: true, locked: false, start: 0, duration: 120, anchorX: 0, anchorY: 0, x: 0, y: 0,
      scale: 1, rotation: 0, opacity: 1, keyframes: {}, points: [], smoothing: 0, size: 40, color: '#fff', rippleColor: '#fff6', clicks,
      clickSound: { assetId: 'tick', volume: 1 },
    });
    p.scenes.push({ id: 's', name: 'S', start: 0, duration: 120, layers: [cursor], background: null, transition: { type: 'none', duration: 0.6, direction: 'left', easing: { type: 'easeInOut' } } });
    const r = buildAudioArgs(p, (a) => `/p/${a.relativePath}`);
    // 333 clicks of 0.03 s = 9.99 s per input.
    expect(r.inputs).toEqual(Array.from({ length: 4 }, () => ['-i', '/p/assets/t-tick.wav']).flat());
    const parts = r.filter[1].split(';');
    expect(parts).toHaveLength(4 + 1200 + 1);
    const labels = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `[a${from + i}]`).join('');
    expect(parts.filter((x) => x.includes('asplit'))).toEqual([
      `[1:a]asplit=333${labels(0, 333)}`,
      `[2:a]asplit=333${labels(333, 666)}`,
      `[3:a]asplit=333${labels(666, 999)}`,
      `[4:a]asplit=201${labels(999, 1200)}`,
    ]);
    expect(parts[1]).toBe(`[a0]atrim=start=0:duration=0.03,${CH},volume=1,adelay=50:all=1[c0]`);
    expect(parts.at(-2)).toBe(`[a1199]atrim=start=0:duration=0.03,${CH},volume=1,adelay=119950:all=1[c1199]`);
    expect(parts.at(-1)).toBe(`${clicks.map((_, i) => `[c${i}]`).join('')}${mixTail(5760000, 1200)}`);
  });

  it('missing files are skipped with one warning per file; other clips are still mixed', () => {
    const r = build(project([{ assetId: 'a' }, { assetId: 'a', start: 1 }, { assetId: 'b', start: 2 }]), ['a']);
    expect(r.warnings).toEqual(['Audio file missing: music.mp3 — exported without it.']);
    expect(r.inputs).toEqual(['-i', files.b]);
    expect(r.filter[1]).toBe(`[1:a]atrim=start=0:duration=1,${CH},volume=1,adelay=2000:all=1[c0];[c0]${mixTail(144000)}`);
  });

  it('only missing clips → no audio stream, but the warning is kept', () => {
    const r = build(project([{}]), ['a']);
    expect(r.inputs).toEqual([]);
    expect(r.filter).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it('cursor clicks with a click sound become one clip per click (inside the layer and scene only)', () => {
    const p = project([]);
    const cursor = makeLayer({
      id: 'cur', name: 'Cursor', type: 'cursor', visible: true, locked: false, start: 0.5, duration: 1.5, anchorX: 0, anchorY: 0, x: 0, y: 0,
      scale: 1, rotation: 0, opacity: 1, keyframes: {}, points: [], smoothing: 0, size: 40, color: '#fff', rippleColor: '#fff6',
      // 0.2 → 0.7 s, 1.0 → 1.5 s; 1.6 s is past the layer's end; 0.6 s is listed out of order on purpose.
      clicks: [{ id: 'k1', time: 0.2 }, { id: 'k3', time: 1.6 }, { id: 'k2', time: 1.0 }],
      clickSound: { assetId: 'b', volume: 0.8 },
    });
    p.scenes.push({ id: 's', name: 'S', start: 0, duration: 3, layers: [cursor], background: null, transition: { type: 'none', duration: 0.6, direction: 'left', easing: { type: 'easeInOut' } } });
    // Both clicks play the same file: one input, split in two.
    expect(build(p).inputs).toEqual(['-i', files.b]);
    expect(graph(p)).toBe(
      `[1:a]asplit=2[a0][a1];[a0]atrim=start=0:duration=2,${CH},volume=0.8,adelay=700:all=1[c0];` +
        `[a1]atrim=start=0:duration=1.5,${CH},volume=0.8,adelay=1500:all=1[c1];[c0][c1]${mixTail(144000, 2)}`,
    );
    // A hidden cursor makes no sound.
    p.scenes[0].layers[0].visible = false;
    expect(build(p).filter).toEqual([]);
  });

  it('the exporter puts the audio inputs after stdin and the AAC options before the output (-f mp4 -movflags …)', () => {
    const p = project([{ start: 0.5 }]);
    const args = ffmpegArgs(p, '/out.mp4', build(p));
    const at = (x: string) => args.indexOf(x);
    // -progress pipe:1: ffmpeg reports its progress on stdout, which the exporter's watchdog reads.
    expect(args.slice(0, at('-filter_complex'))).toEqual(['-y', '-loglevel', 'error', '-progress', 'pipe:1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '640x360', '-r', '30', '-i', '-', '-i', files.a]);
    expect(args.slice(at('-filter_complex') + 2, at('-vf'))).toEqual(['-map', '0:v', '-map', '[aout]']);
    expect(args.slice(at('-c:a'), args.lastIndexOf('-f'))).toEqual(['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']);
    expect(args.slice(-5)).toEqual(['-f', 'mp4', '-movflags', '+faststart', '/out.mp4']);
    // No audio → the v1 command, unchanged.
    expect(ffmpegArgs(project([]), '/out.mp4')).not.toContain('-filter_complex');
    expect(ffmpegArgs(project([]), '/out.mp4', build(project([])))).toEqual(ffmpegArgs(project([]), '/out.mp4'));
  });

  it('num() prints plain decimals', () => {
    expect([num(0), num(1), num(0.5), num(1000), num(1033.3333333), num(1e-7), num(2.5e-6), num(-0)]).toEqual(['0', '1', '0.5', '1000', '1033.333333', '0', '0.000003', '0']);
  });
});
