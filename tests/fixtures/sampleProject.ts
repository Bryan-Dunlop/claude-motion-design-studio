import { emptyProject, ProjectSchema, type Project, type ProjectInput } from '../../src/shared/schema';

/** Small 1080p project with animated text and a cursor (no assets). */
export function sampleProject(): Project {
  const p: ProjectInput = emptyProject();
  p.settings = { ...p.settings, width: 1920, height: 1080 };
  p.scenes.push({
    id: 's1', name: 'Scene 1', start: 0, duration: 15,
    layers: [
      {
        id: 't1', name: 'T', type: 'text', visible: true, locked: false, start: 0, duration: 10, anchorX: 0.5, anchorY: 0.5,
        x: 960, y: 540, scale: 1, rotation: 0, opacity: 1,
        keyframes: { x: [{ id: 'a', time: 0, value: 100, easing: { type: 'spring', stiffness: 120, damping: 8, mass: 1 } }, { id: 'b', time: 2, value: 900, easing: { type: 'linear' } }] },
        content: 'Hello\nWorld', fontFamily: 'Inter', fontSize: 80, fontWeight: 700, lineHeight: 1.2, letterSpacing: 2, align: 'center', color: '#ffffff',
      },
      {
        id: 'c1', name: 'C', type: 'cursor', visible: true, locked: false, start: 0, duration: 10, anchorX: 0, anchorY: 0,
        x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keyframes: {},
        points: [{ id: 'p1', x: 0, y: 0, time: 0 }, { id: 'p2', x: 100, y: 0, time: 1 }, { id: 'p3', x: 100, y: 100, time: 2 }],
        clicks: [{ id: 'k1', time: 1 }], smoothing: 1, size: 30, color: '#ffffff', rippleColor: '#ffffff66',
      },
    ],
  });
  return ProjectSchema.parse(p);
}
