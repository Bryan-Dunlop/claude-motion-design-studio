import { describe, expect, it } from 'vitest';
import { exportSize } from '../../src/shared/exportSize';

describe('exportSize', () => {
  it('full size keeps even project sizes and the scale 1', () => {
    expect(exportSize({ width: 3840, height: 2160 }, 1)).toEqual({ outW: 3840, outH: 2160, scale: 1 });
  });
  it('rounds to even sizes and picks a scale that fills them (never an unpainted edge)', () => {
    const r = exportSize({ width: 1080, height: 1350 }, 0.5);
    expect(r).toMatchObject({ outW: 540, outH: 676 });
    expect(1080 * r.scale).toBeGreaterThanOrEqual(r.outW);
    expect(1350 * r.scale).toBeGreaterThanOrEqual(r.outH);
    const odd = exportSize({ width: 1001, height: 1001 }, 1);
    expect(odd.outW % 2).toBe(0);
    expect(1001 * odd.scale).toBeGreaterThanOrEqual(odd.outW);
  });
  it('1366x768 at 50% → 684x384', () => {
    expect(exportSize({ width: 1366, height: 768 }, 0.5)).toMatchObject({ outW: 684, outH: 384 });
  });
});
