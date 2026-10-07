// Font strings for canvas `ctx.font`: an invalid shorthand is silently ignored (the canvas keeps 10px sans-serif).
import { describe, expect, it } from 'vitest';
import { cssFontFamily, fontString } from '../../src/shared/geometry';

describe('fontString / cssFontFamily', () => {
  it('quotes names a bare CSS identifier cannot carry: leading digits, reserved words, spaces, quotes', () => {
    expect(fontString({ fontWeight: 700, fontSize: 173, fontFamily: '3Dee' })).toBe('700 173px "3Dee", sans-serif');
    expect(cssFontFamily('04B_03__')).toBe('"04B_03__"');
    expect(cssFontFamily('3270-Regular')).toBe('"3270-Regular"');
    expect(cssFontFamily('Default')).toBe('"Default"');
    expect(cssFontFamily('Inherit')).toBe('"Inherit"');
    expect(cssFontFamily('My Font 2')).toBe('"My Font 2"');
    expect(cssFontFamily('Odd "Name"\\')).toBe('"Odd \\"Name\\"\\\\"');
  });

  it('keeps plain names and generic families bare (unchanged v1 strings)', () => {
    expect(fontString({ fontWeight: 400, fontSize: 50, fontFamily: 'Inter' })).toBe('400 50px Inter, sans-serif');
    expect(cssFontFamily('TestFace')).toBe('TestFace');
    expect(cssFontFamily('serif')).toBe('serif');
    expect(cssFontFamily('monospace')).toBe('monospace');
    expect(cssFontFamily('"Quoted Name", 3D, sans-serif')).toBe('"Quoted Name", "3D", sans-serif');
  });
});
