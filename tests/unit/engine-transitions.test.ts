// A1 scene background + transitions in Node: which scenes draw (partner rule at render time), the per-style draw
// sequences with injected recording canvases, and the slide/push/wipe geometry. Pixel checks (dissolve endpoints,
// export matches) live in tests/e2e/engine-transitions.spec.ts.
import { describe, expect, it } from 'vitest';
import { makeProject } from '../../src/shared/factories';
import { renderFrame } from '../../src/shared/renderFrame';
import type { Project, SceneInput, Transition } from '../../src/shared/schema';
import { blurPad, directionalLayout, dissolve, zoomFactor } from '../../src/shared/transitionDraw';
import { planTransitions, transitionProgress } from '../../src/shared/transitions';
import { allRecorders, recordingCtx, unclippedFilteredDraws } from './helpers/recordingCtx';

const W = 1600;
const H = 900;

function label(text: string) {
  return {
    id: `t-${text}`, name: text, type: 'text' as const, visible: true, locked: false, start: 0, duration: 20, anchorX: 0.5, anchorY: 0.5,
    x: 800, y: 450, scale: 1, rotation: 0, opacity: 1, keyframes: {},
    content: text, fontFamily: 'Inter', fontSize: 80, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center' as const, color: '#ffffff',
  };
}

const sc = (name: string, start: number, duration: number, transition?: Partial<Transition>, extra: Partial<SceneInput> = {}): SceneInput => ({
  id: name, name, start, duration, layers: [label(name)],
  transition: { type: 'none', duration: 1, direction: 'left', easing: { type: 'linear' }, ...transition },
  ...extra,
});

const proj = (...scenes: SceneInput[]): Project =>
  makeProject({ schemaVersion: 2, settings: { durationSec: 20, aspect: '16:9', width: W, height: H, fps: 30, background: '#101010' }, assets: [], scenes });

function render(p: Project, t: number, scale = 1) {
  const rec = recordingCtx(W * scale, H * scale);
  renderFrame(p, t, rec.ctx, scale, { images: new Map(), canvasPool: rec.pool });
  return rec;
}

const texts = (log: string[]) => log.filter((l) => l.startsWith('fillText')).map((l) => JSON.parse(l.slice(9, -1))[0] as string);

describe('scene background', () => {
  it('fills the whole frame with the scene colour before its layers; null shows the project background', () => {
    const rec = render(proj(sc('A', 0, 5, undefined, { background: '#ff0000' }), sc('B', 0, 5)), 1);
    const fills = rec.log.filter((l) => l.startsWith('fillStyle=') || l.startsWith('fillRect') || l.startsWith('fillText'));
    expect(fills.slice(0, 5)).toEqual([
      'fillStyle="#101010"', `fillRect([0,0,${W},${H}])`, // project background
      'fillStyle="#ff0000"', `fillRect([0,0,${W},${H}])`, // scene A's own background
      'fillStyle="#ffffff"', // then A's layers
    ]);
    // Scene B has no background: only its text follows.
    expect(rec.log.filter((l) => l === 'fillStyle="#ff0000"')).toHaveLength(1);
  });
});

describe('transition plan at render time', () => {
  it('sequential scenes: B draws A (holding its last frame) and A is skipped in the normal draw', () => {
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'slide' }));
    const { plans, partners } = planTransitions(p, 5.5);
    expect(plans.get('B')).toMatchObject({ partner: { id: 'A' }, progress: 0.5 });
    expect([...partners]).toEqual(['A']);
    expect(texts(render(p, 5.5).log)).toEqual(['A', 'B']);
    // Outside the window: a plain cut, A gone.
    expect(planTransitions(p, 6).plans.size).toBe(0);
    expect(texts(render(p, 6).log)).toEqual(['B']);
  });

  it('a long overlay scene running past the window is not a partner and keeps drawing in array order', () => {
    const p = proj(sc('Hook', 0, 5), sc('Feature', 5, 5, { type: 'wipe' }), sc('Logo', 0, 15));
    expect([...planTransitions(p, 5.3).partners]).toEqual(['Hook']);
    expect(texts(render(p, 5.3).log)).toEqual(['Hook', 'Feature', 'Logo']);
  });

  it('a gap before the scene: no partner, the scene transitions in over the background', () => {
    const p = proj(sc('A', 0, 4), sc('B', 5, 5, { type: 'push' }));
    expect(planTransitions(p, 5.5).plans.get('B')!.partner).toBeNull();
    expect(texts(render(p, 5.5).log)).toEqual(['B']);
  });

  it('a scene is the partner of one transition only (earlier in the array wins a tie)', () => {
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'wipe' }), sc('C', 5, 5, { type: 'wipe' }));
    const { plans } = planTransitions(p, 5.5);
    expect(plans.get('B')!.partner?.id).toBe('A');
    expect(plans.get('C')!.partner).toBeNull();
    expect(texts(render(p, 5.5).log)).toEqual(['A', 'B', 'C']);
  });

  it('a scene drawn as a partner does not run its own transition', () => {
    // P is still inside its own 2 s window when S (whose window ends at P's end) takes it as its partner.
    const p = proj(sc('Q', 0, 4.5), sc('P', 4, 2, { type: 'fade', duration: 2 }), sc('S', 5, 5, { type: 'wipe', duration: 1 }));
    const { plans, partners } = planTransitions(p, 5.5);
    expect(plans.has('P')).toBe(false);
    expect(plans.get('S')!.partner?.id).toBe('P');
    expect([...partners]).toEqual(['P']);
  });

  it('progress is clamped to 0..1 even when a spring overshoots', () => {
    const spring = { type: 'spring', stiffness: 300, damping: 4, mass: 1 } as const;
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'slide', duration: 2, easing: spring }));
    const over = [...Array(200)].map((_, i) => 5 + i / 100).find((t) => transitionProgress(p.scenes[1], t)! > 1)!;
    expect(over).toBeDefined();
    expect(planTransitions(p, over).plans.get('B')!.progress).toBe(1);
  });
});

describe('slide / push / wipe: drawn straight onto the frame (no offscreens)', () => {
  it('slide left: B enters from the right edge, A keeps the uncovered part', () => {
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'slide', direction: 'left' }));
    const rec = render(p, 5.25, 0.5); // p = 0.25 → boundary at 0.75 × 800 = 600
    expect(rec.children).toHaveLength(0);
    const s = rec.log.join('\n');
    expect(s).toContain('rect([0,0,600,450])\nclip([])\nsetTransform([0.5,0,0,0.5,0,0])'); // A, not moved
    expect(s).toContain('rect([600,0,200,450])\nclip([])\nsetTransform([0.5,0,0,0.5,600,0])'); // B, moved right by 600
  });

  it('push right: A moves out to the right while B follows from the left', () => {
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'push', direction: 'right' }));
    const s = render(p, 5.25).log.join('\n'); // boundary at 0.25 × 1600 = 400
    expect(s).toContain('rect([400,0,1200,900])\nclip([])\nsetTransform([1,0,0,1,400,0])'); // A
    expect(s).toContain('rect([0,0,400,900])\nclip([])\nsetTransform([1,0,0,1,-1200,0])'); // B
  });

  it('wipe up: no movement, B revealed from the bottom', () => {
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'wipe', direction: 'up' }));
    const s = render(p, 5.75).log.join('\n'); // boundary at 0.25 × 900 = 225
    expect(s).toContain('rect([0,0,1600,225])\nclip([])\nsetTransform([1,0,0,1,0,0])'); // A
    expect(s).toContain('rect([0,225,1600,675])\nclip([])\nsetTransform([1,0,0,1,0,0])'); // B
  });

  it('at the window start the incoming scene is fully outside (nothing drawn for it)', () => {
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'slide', direction: 'down' }));
    expect(texts(render(p, 5).log)).toEqual(['A']);
  });
});

describe('directional layout', () => {
  const lay = (type: 'slide' | 'push' | 'wipe', d: Transition['direction'], p: number) => directionalLayout(type, d, p, 1000, 500);
  it('direction is the direction of travel, with a whole-pixel boundary', () => {
    expect(lay('slide', 'left', 0.3).to).toEqual({ x: 700, y: 0, clip: { x0: 700, y0: 0, x1: 1000, y1: 500 } });
    expect(lay('slide', 'right', 0.3).to).toEqual({ x: -700, y: 0, clip: { x0: 0, y0: 0, x1: 300, y1: 500 } });
    expect(lay('slide', 'up', 0.3).to).toEqual({ x: 0, y: 350, clip: { x0: 0, y0: 350, x1: 1000, y1: 500 } });
    expect(lay('slide', 'down', 0.3).to).toEqual({ x: 0, y: -350, clip: { x0: 0, y0: 0, x1: 1000, y1: 150 } });
    expect(lay('slide', 'left', 0.3).from).toEqual({ x: 0, y: 0, clip: { x0: 0, y0: 0, x1: 700, y1: 500 } });
    expect(lay('push', 'left', 0.3).from.x).toBe(-300);
    expect(lay('push', 'down', 0.3).from.y).toBe(150);
    expect(lay('wipe', 'right', 0.3)).toEqual({ from: { x: 0, y: 0, clip: { x0: 300, y0: 0, x1: 1000, y1: 500 } }, to: { x: 0, y: 0, clip: { x0: 0, y0: 0, x1: 300, y1: 500 } } });
    expect(directionalLayout('slide', 'left', 0.3333, 999.5, 500).to.x).toBe(666); // 666.4 → whole pixel
  });
});

describe('fade / zoom / blur: backdrop-inclusive opaque offscreens + lighter dissolve', () => {
  it('fade: O′ and I′ start as copies of the frame so far, then the dissolve, then one draw onto the frame', () => {
    const p = proj(sc('Base', 0, 20), sc('A', 0, 5), sc('B', 5, 5, { type: 'fade' }));
    const rec = render(p, 5.25);
    expect(rec.children).toHaveLength(3);
    const [O, I, T] = rec.children;
    expect(O.log[0]).toBe('drawImage(["<canvas main>",0,0])');
    expect(texts(O.log)).toEqual(['A']);
    expect(I.log[0]).toBe('drawImage(["<canvas main>",0,0])');
    expect(texts(I.log)).toEqual(['B']);
    expect(T.log).toEqual([
      'save([])', 'globalAlpha=0.75', 'drawImage(["<canvas main.0>",0,0])',
      'globalCompositeOperation="lighter"', 'globalAlpha=0.25', 'drawImage(["<canvas main.1>",0,0])', 'restore([])',
    ]);
    // The lower scene "Base" is drawn on the frame once, before the transition copies it.
    const s = rec.log.join('\n');
    expect(texts(rec.log)).toEqual(['Base']);
    expect(s).toContain('setTransform([1,0,0,1,0,0])\ndrawImage(["<canvas main.2>",0,0])');
  });

  it('dissolve endpoints: p = 0 draws only the outgoing image, p = 1 only the incoming one', () => {
    const run = (p: number) => {
      const rec = recordingCtx(10, 10);
      dissolve(rec.ctx, { canvas: { name: 'O', width: 10, height: 10 } as never, pad: 0 }, { canvas: { name: 'I', width: 10, height: 10 } as never, pad: 0 }, p);
      return rec.log.filter((l) => l.startsWith('drawImage'));
    };
    expect(run(0)).toEqual(['drawImage(["<canvas O>",0,0])']);
    expect(run(1)).toEqual(['drawImage(["<canvas I>",0,0])']);
    expect(run(0.5)).toHaveLength(2);
    // At the window start the incoming side isn't even rendered.
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'fade' }));
    expect(render(p, 5).children).toHaveLength(2);
  });

  it('zoom: the incoming layers are drawn under a vector scale 1.25 → 1 about the frame centre', () => {
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'zoom' }));
    const rec = render(p, 5.5, 0.5);
    const z = zoomFactor(0.5);
    expect(z).toBeCloseTo(1.125);
    const I = rec.children[1];
    const zs = 0.5 * z;
    expect(I.log).toContain(`setTransform([${zs},0,0,${zs},${400 * (1 - z)},${225 * (1 - z)}])`);
    // The outgoing side is not zoomed.
    expect(rec.children[0].log.filter((l) => l.startsWith('setTransform'))).toEqual(['setTransform([0.5,0,0,0.5,0,0])']);
  });

  it('blur: padded canvases filled with the scene colour, blurred, then cropped back out in the dissolve', () => {
    const p = proj(sc('A', 0, 5, undefined, { background: '#223344' }), sc('B', 5, 5, { type: 'blur' }));
    const rec = render(p, 5.5, 0.5);
    const B = 0.03 * W * 0.5; // 3% of the long edge × scale = 24 px
    const r = 0.5 * B;
    const m = blurPad(r);
    expect(m).toBeGreaterThanOrEqual(Math.ceil(3 * r));
    const [Opad, Oblur, Ipad, Iblur, T] = rec.children;
    expect(Opad.log.slice(0, 3)).toEqual(['fillStyle="#223344"', `fillRect([0,0,${800 + 2 * m},${450 + 2 * m}])`, `drawImage(["<canvas main>",${m},${m}])`]);
    expect(Ipad.log[0]).toBe('fillStyle="#101010"'); // B has no background: the project colour
    expect(Oblur.log).toEqual([`beginPath([])`, `rect([0,0,${800 + 2 * m},${450 + 2 * m}])`, 'clip([])', `filter="blur(${r}px)"`, 'drawImage(["<canvas main.0>",0,0])']);
    expect(Iblur.log).toContain(`filter="blur(${r}px)"`);
    expect(T.log).toContain(`drawImage(["<canvas main.1>",${m},${m},800,450,0,0,800,450])`);
    expect(T.log).toContain(`drawImage(["<canvas main.3>",${m},${m},800,450,0,0,800,450])`);
    for (const x of allRecorders(rec)) expect(unclippedFilteredDraws(x.log)).toEqual([]);
  });

  it('layer effects inside a transition use the zoomed scale and stay clipped', () => {
    const blurred = { ...label('B'), blur: 4, shadow: true, shadowBlur: 8, shadowOffsetY: 4, content: 'B\nC' };
    const p = proj(sc('A', 0, 5), { ...sc('B', 5, 5, { type: 'zoom' }), layers: [blurred] });
    const rec = render(p, 5.5);
    const z = zoomFactor(0.5);
    expect(rec.children[1].log).toContain(`filter="blur(${4 * z}px)"`);
    for (const x of allRecorders(rec)) expect(unclippedFilteredDraws(x.log)).toEqual([]);
  });

  it('releases pooled canvases once per frame and is deterministic', () => {
    const p = proj(sc('A', 0, 5), sc('B', 5, 5, { type: 'blur' }), sc('C', 10, 5, { type: 'zoom' }));
    const a = render(p, 5.4);
    render(p, 10.3);
    const b = render(p, 5.4);
    expect(a.releases()).toBe(1);
    expect(allRecorders(b).map((r) => r.log)).toEqual(allRecorders(a).map((r) => r.log));
  });
});
