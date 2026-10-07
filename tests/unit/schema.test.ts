// Schema v2: old (v1) project files must keep opening, with every new field filled by defaults.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeLayer, makeScene } from '../../src/shared/factories';
import { ANIMATABLE, emptyProject, ProjectSchema, SCHEMA_VERSION } from '../../src/shared/schema';

const v1 = () => JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/v1-project.json'), 'utf8'));

describe('schema v2 migration', () => {
  it('fixture really is a v1 file saved by Motion Studio v1', () => {
    expect(v1().schemaVersion).toBe(1);
    expect(v1().audio).toBeUndefined();
  });

  it('opens a v1 project and fills every new field with defaults', () => {
    const p = ProjectSchema.parse(v1());
    expect(SCHEMA_VERSION).toBe(2);
    expect(p.schemaVersion).toBe(2);
    expect(p.audio).toEqual([]);
    const scene = p.scenes[0];
    expect(scene.background).toBeNull();
    expect(scene.transition).toEqual({ type: 'none', duration: 0.6, direction: 'left', easing: { type: 'easeInOut' } });
    for (const l of scene.layers) {
      expect(l).toMatchObject({ blur: 0, shadow: false, shadowColor: '#00000040', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, blendMode: 'normal' });
      if (l.type === 'text') expect(l).toMatchObject({ fillMode: 'solid', strokeWidth: 0, textIn: null, textOut: null });
      if (l.type === 'shape') expect(l).toMatchObject({ points: 5, innerRadius: 0.45, trimStart: 0, trimEnd: 1, trimOffset: 0, lineCap: 'round', fillMode: 'solid' });
    }
    // Everything that was in the v1 file is preserved untouched.
    const before = v1();
    expect(p.settings).toEqual(before.settings);
    expect(p.assets).toEqual(before.assets);
    expect(p.scenes[0].layers.map((l) => [l.id, l.type, l.x, l.y, l.keyframes])).toEqual(
      before.scenes[0].layers.map((l: Record<string, unknown>) => [l.id, l.type, l.x, l.y, l.keyframes]),
    );
  });

  it('a migrated project round-trips unchanged through JSON', () => {
    const p = ProjectSchema.parse(v1());
    expect(ProjectSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('rejects unknown future versions instead of guessing', () => {
    expect(() => ProjectSchema.parse({ ...v1(), schemaVersion: 3 })).toThrow();
  });

  it('default objects are fresh per parse (no shared mutable defaults)', () => {
    const a = ProjectSchema.parse(v1());
    const b = ProjectSchema.parse(v1());
    expect(a.scenes[0].transition).not.toBe(b.scenes[0].transition);
    expect(a.audio).not.toBe(b.audio);
  });

  it('factories build complete layers and scenes', () => {
    const l = makeLayer({
      id: 'x', name: 'X', type: 'shape', visible: true, locked: false, start: 0, duration: 1, anchorX: 0.5, anchorY: 0.5,
      x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keyframes: {}, shape: 'star', width: 10, height: 10, cornerRadius: 0,
      fill: '#fff', stroke: '#000', strokeWidth: 0,
    });
    expect(l.type).toBe('shape');
    expect(l.trimEnd).toBe(1);
    const s = makeScene({ id: 's', name: 'S', start: 0, duration: 2, layers: [l] });
    expect(s.transition.type).toBe('none');
    expect(ProjectSchema.parse({ ...emptyProject(), scenes: [s] }).scenes[0].layers[0]).toEqual(l);
  });

  it('every animatable property exists on a default layer of that type', () => {
    const p = ProjectSchema.parse(v1());
    for (const l of p.scenes[0].layers) {
      for (const prop of ANIMATABLE[l.type]) expect(l, `${l.type}.${prop}`).toHaveProperty(prop);
    }
  });
});
