// Keyframe / layer / clip copy-paste rules (src/app/clipboard.ts).
import { freeze, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { copyClips, copyKeys, copyLayers, pasteClips, pasteKeys, pasteKeysMessage, pasteLayers, type CopiedKey, type PasteKeysResult } from '../../src/app/clipboard';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { emptyProject, type Keyframe, type Layer, type Project } from '../../src/shared/schema';

const base = { visible: true, locked: false, anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, opacity: 1 };
const key = (id: string, time: number, value: number | string, extra: Partial<Keyframe> = {}): Keyframe => ({ id, time, value, easing: { type: 'easeInOut' }, ...extra });

function project(): Project {
  return makeProject({
    ...emptyProject(),
    settings: { durationSec: 10, aspect: '16:9', width: 1920, height: 1080, fps: 30, background: '#000000' },
    assets: [
      { id: 'img', originalName: 'logo.png', relativePath: 'assets/logo.png', type: 'image', hash: 'h1', width: 10, height: 10 },
      { id: 'fnt', originalName: 'Brand.woff2', relativePath: 'assets/Brand.woff2', type: 'font', hash: 'h2', fontFamily: 'Brand' },
      { id: 'snd', originalName: 'click.wav', relativePath: 'assets/click.wav', type: 'audio', hash: 'h3', duration: 0.2 },
      { id: 'other', originalName: 'unused.png', relativePath: 'assets/unused.png', type: 'image', hash: 'h4', width: 10, height: 10 },
    ],
    scenes: [
      {
        id: 's1', name: 'One', start: 1, duration: 6,
        layers: [
          // Source of the motion: x 100 → 500 and y 200 → 300 between 0.5 s and 1.5 s (layer time), opacity too.
          makeLayer({ ...base, id: 'src', name: 'Box', type: 'shape', start: 0, duration: 5, x: 100, y: 200, shape: 'rect', width: 50, height: 50, cornerRadius: 4, fill: '#ff0000', stroke: '#fff', strokeWidth: 0,
            keyframes: {
              x: [key('x1', 0.5, 100, { source: 'preset:in' }), key('x2', 1.5, 500, { easing: { type: 'linear' } })],
              y: [key('y1', 0.5, 200), key('y2', 1.5, 300)],
              opacity: [key('o1', 0.5, 0), key('o2', 1, 1)],
              cornerRadius: [key('r1', 0.5, 4)],
            } }),
          makeLayer({ ...base, id: 'txt', name: 'Title', type: 'text', start: 1, duration: 3, x: 960, y: 540, keyframes: { y: [key('ty', 0, 540), key('ty2', 2, 700)] },
            content: 'Hi', fontFamily: 'Brand', fontSize: 40, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center', color: '#fff' }),
          makeLayer({ ...base, id: 'cur', name: 'Pointer', type: 'cursor', start: 0, duration: 6, x: 0, y: 0, keyframes: {}, points: [{ id: 'p1', x: 5, y: 5, time: 0 }],
            clicks: [{ id: 'c1', time: 1 }], smoothing: 0, size: 20, color: '#fff', rippleColor: '#fff', clickSound: { assetId: 'snd', volume: 1 } }),
          makeLayer({ ...base, id: 'pic', name: 'Logo', type: 'image', start: 0, duration: 6, x: 10, y: 10, keyframes: {}, assetId: 'img', width: 10, height: 10 }),
        ],
      },
      { id: 's2', name: 'Two', start: 7, duration: 3, layers: [] },
    ],
    audio: [
      { id: 'a1', name: 'music', assetId: 'snd', start: 2, trimStart: 0, duration: 0.2, volume: 1, fadeIn: 0, fadeOut: 0, muted: false },
      { id: 'a2', name: 'music 2', assetId: 'snd', start: 3, trimStart: 0, duration: 0.2, volume: 0.5, fadeIn: 0, fadeOut: 0, muted: false },
    ],
  });
}

const layer = (p: Project, id: string) => p.scenes.flatMap((s) => s.layers).find((l) => l.id === id) as Layer;
let n = 0;
const newId = () => `new${++n}`;

function paste(p: Project, targets: string[], keys: CopiedKey[], time: number, relative = true) {
  let r: PasteKeysResult | null = null;
  const next = produce(p, (d) => void (r = pasteKeys(d, targets, keys, time, { relative, newId })));
  return { next, r: r! };
}

describe('copy keyframes', () => {
  it('copies the selected keys with absolute times, earliest first, as plain (unfrozen) data', () => {
    const p = freeze(project(), true); // committed state is frozen by immer
    const keys = copyKeys(p, ['x2', 'x1', 'o1']);
    expect(keys).toEqual([
      { prop: 'x', time: 1.5, value: 100, easing: { type: 'easeInOut' }, source: 'preset:in' },
      { prop: 'opacity', time: 1.5, value: 0, easing: { type: 'easeInOut' } },
      { prop: 'x', time: 2.5, value: 500, easing: { type: 'linear' } },
    ]);
    expect(Object.isFrozen(keys[0].easing)).toBe(false);
    expect(keys[0].easing).not.toBe(layer(p, 'src').keyframes.x[0].easing);
  });
});

describe('paste keyframes', () => {
  const p = project();
  const motion = copyKeys(p, ['x1', 'x2', 'y1', 'y2', 'o1', 'o2']);

  it('relative: x/y start from the target\'s current value at the playhead; spacing and other properties as copied', () => {
    // Playhead 3 s = 1 s into the Title layer (scene 1 + layer 1). Title's y is animated: 620 there.
    const { next, r } = paste(p, ['txt'], motion, 3);
    const t = layer(next, 'txt');
    expect(t.keyframes.x.map((k) => [k.time, k.value])).toEqual([[1, 960], [2, 1360]]);
    expect(t.keyframes.y.map((k) => [k.time, k.value])).toEqual([[0, 540], [1, 620], [2, 720]]);
    expect(t.keyframes.opacity.map((k) => [k.time, k.value])).toEqual([[1, 0], [1.5, 1]]);
    // Easing and preset tag travel with the keys; ids are new.
    expect(t.keyframes.x[1].easing).toEqual({ type: 'linear' });
    expect(t.keyframes.x[0].source).toBe('preset:in');
    expect(r).toMatchObject({ skipped: 0, refused: [] });
    expect(r.ids).toHaveLength(6);
    expect(r.ids.every((id) => id.startsWith('new'))).toBe(true);
    expect(pasteKeysMessage(r)).toBe('Pasted 6 keyframes');
  });

  it('absolute (Ctrl+Shift+V): values exactly as copied', () => {
    const { next } = paste(p, ['txt'], motion, 3, false);
    expect(layer(next, 'txt').keyframes.x.map((k) => k.value)).toEqual([100, 500]);
    // y had a key at 2 s (layer time) which the pasted 300 replaces; 540 at 0 s stays.
    expect(layer(next, 'txt').keyframes.y.map((k) => [k.time, k.value])).toEqual([[0, 540], [1, 200], [2, 300]]);
  });

  it('a key on the same frame is replaced, not doubled', () => {
    const { next } = paste(p, ['txt'], copyKeys(p, ['y1']), 3.01, false);
    expect(layer(next, 'txt').keyframes.y.map((k) => [k.time, k.value])).toEqual([[0, 540], [1.01, 200], [2, 700]]);
    // 1 s is within half a frame (1/60 s) of 1.01 s: that key is replaced.
    const again = produce(next, (d) => void pasteKeys(d, ['txt'], copyKeys(p, ['y2']), 3, { relative: false, newId }));
    expect(layer(again, 'txt').keyframes.y.map((k) => k.value)).toEqual([540, 300, 700]);
  });

  it('pastes onto every selected layer; properties a layer type cannot animate are skipped and reported', () => {
    const { next, r } = paste(p, ['txt', 'cur'], copyKeys(p, ['x1', 'o1', 'r1']), 3);
    // Text: x + opacity (no corner radius on text). Cursor: opacity only (no x, no corner radius).
    expect(Object.keys(layer(next, 'txt').keyframes).sort()).toEqual(['opacity', 'x', 'y']);
    expect(Object.keys(layer(next, 'cur').keyframes)).toEqual(['opacity']);
    expect(r.ids).toHaveLength(3);
    expect(r.skipped).toBe(3);
    expect(r.skippedTypes).toEqual(['text', 'cursor']);
    expect(pasteKeysMessage(r)).toBe('Pasted 3 keyframes (3 skipped: not available on text or cursor)');
    expect(pasteKeysMessage({ ids: ['a', 'b', 'c', 'd', 'e', 'f'], skipped: 2, skippedTypes: ['text'], refused: [] })).toBe('Pasted 6 keyframes (2 skipped: not available on text)');
  });

  it('times are clamped to the layer; a playhead outside the layer refuses that layer', () => {
    // Title runs 2–5 s. At 4.5 s the second x key (1 s later) would be past its end: clamped to the end.
    const { next, r } = paste(p, ['txt'], copyKeys(p, ['x1', 'x2']), 4.5);
    expect(layer(next, 'txt').keyframes.x.map((k) => k.time)).toEqual([2.5, 3]);
    expect(r.ids).toHaveLength(2);
    const out = paste(p, ['txt'], motion, 1.5);
    expect(out.r).toEqual({ ids: [], skipped: 0, skippedTypes: [], refused: ['Title'] });
    expect(out.next).toBe(p); // nothing changed
    expect(pasteKeysMessage(out.r)).toBe('Move the playhead inside "Title" to paste keyframes there.');
    const mixed = paste(p, ['txt', 'pic'], copyKeys(p, ['o1']), 1.5);
    expect(pasteKeysMessage(mixed.r)).toBe('Pasted 1 keyframe — move the playhead inside "Title" to paste there too');
  });

  it('two copied keys landing on the same (clamped) frame leave one key, and only existing ids are reported', () => {
    const { next, r } = paste(p, ['txt'], copyKeys(p, ['x1', 'x2']), 5);
    expect(layer(next, 'txt').keyframes.x.map((k) => [k.time, k.value])).toEqual([[3, 1360]]);
    expect(r.ids).toEqual([layer(next, 'txt').keyframes.x[0].id]);
  });
});

describe('copy / paste layers and clips', () => {
  it('layers paste into the given scene at the same scene-relative timing, with new ids and their assets', () => {
    const p = project();
    const clip = copyLayers(p, ['pic', 'cur', 'txt']);
    expect(clip.layers.map((l) => l.id)).toEqual(['txt', 'cur', 'pic']); // drawing order
    expect(clip.assets.map((a) => a.id).sort()).toEqual(['fnt', 'img', 'snd']);
    let ids: string[] = [];
    const next = produce(p, (d) => void (ids = pasteLayers(d, 's2', clip)));
    const pasted = next.scenes[1].layers;
    expect(pasted.map((l) => [l.name, l.start, l.duration])).toEqual([['Title', 1, 3], ['Pointer', 0, 6], ['Logo', 0, 6]]);
    expect(pasted.map((l) => l.id)).toEqual(ids);
    expect(ids.some((id) => ['txt', 'cur', 'pic'].includes(id))).toBe(false);
    const cursor = pasted[1];
    if (cursor.type !== 'cursor') throw new Error('cursor expected');
    expect(cursor.points[0].id).not.toBe('p1');
    expect(cursor.clicks[0].id).not.toBe('c1');
    expect(layer(next, 'txt').keyframes.y[0].id).toBe('ty');
    expect(pasted[0].keyframes.y[0].id).not.toBe('ty');
    // Same project: no duplicate assets.
    expect(next.assets).toHaveLength(4);
  });

  it('a name already in the scene gets " copy"; assets missing in another project come along', () => {
    const p = project();
    const clip = copyLayers(p, ['pic']);
    const same = produce(p, (d) => void pasteLayers(d, 's1', clip));
    expect(same.scenes[0].layers.map((l) => l.name)).toEqual(['Box', 'Title', 'Pointer', 'Logo', 'Logo copy']);
    const other = makeProject({ ...emptyProject(), scenes: [{ id: 'z', name: 'Z', start: 0, duration: 2, layers: [] }] });
    const into = produce(other, (d) => void pasteLayers(d, 'z', clip));
    expect(into.assets.map((a) => a.id)).toEqual(['img']);
    expect(into.scenes[0].layers[0].name).toBe('Logo');
  });

  it('clips paste at the playhead keeping their spacing', () => {
    const p = project();
    const clip = copyClips(p, ['a2', 'a1']);
    let ids: string[] = [];
    const next = produce(p, (d) => void (ids = pasteClips(d, clip, 6, newId)));
    expect(next.audio.slice(2).map((c) => [c.id, c.start, c.volume])).toEqual([[ids[0], 6, 1], [ids[1], 7, 0.5]]);
  });
});
