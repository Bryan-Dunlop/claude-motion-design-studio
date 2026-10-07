import { describe, expect, it } from 'vitest';
import { safeFileName, sanitizeName } from '../../src/shared/names';

describe('sanitizeName', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeName('My project 2')).toBe('My project 2');
    expect(sanitizeName('Promo.motion')).toBe('Promo');
  });
  it('drops path characters and trailing dots/spaces', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeName('a\\b:c*?"<>|')).toBe('abc');
    expect(sanitizeName('name. . ')).toBe('name');
  });
  it('never returns a Windows reserved device name', () => {
    for (const n of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'lpt9']) expect(sanitizeName(n)).toBe(`${n}_`);
    expect(sanitizeName('CONSOLE')).toBe('CONSOLE');
  });
  it('limits the length', () => {
    expect(sanitizeName('x'.repeat(200)).length).toBe(80);
  });
});

describe('safeFileName', () => {
  it('keeps the extension and truncates long names', () => {
    const n = safeFileName(`${'very long name '.repeat(10)}.PNG`);
    expect(n.endsWith('.png')).toBe(true);
    expect(n.length).toBeLessThanOrEqual(60);
  });
  it('replaces unsafe characters', () => {
    expect(safeFileName('my logo (final).svg')).toBe('my_logo_final_.svg');
  });
});
