// B3 export options: zod defaults/validation, the dialog's Size/Quality labels, output file names, the ffmpeg command
// and the CLI flags (server/cliArgs.ts); the PNG still's frame number and file name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { parseRenderArgs } from '../../server/cliArgs';
import { ffmpegArgs, freeOutFile, isExportTarget } from '../../server/exporter';
import { loadPrefs } from '../../src/app/prefs';
import { frameAt, stillFileName } from '../../src/app/still';
import { EXPORT_SCALES, exportFileName, ExportOptionsSchema, exportSize, parseExportOptions, QUALITIES, sizeLabel } from '../../src/shared/exportSize';
import { makeProject } from '../../src/shared/factories';
import { emptyProject } from '../../src/shared/schema';

const at = (width: number, height: number) => makeProject({ ...emptyProject(), settings: { durationSec: 1, aspect: 'custom', width, height, fps: 30, background: '#000000' } });

describe('export options', () => {
  it('every option is optional: 100%, CRF 16, medium, with audio', () => {
    expect(ExportOptionsSchema.parse({})).toEqual({ scale: 1, crf: 16, preset: 'medium', audio: true });
    expect(parseExportOptions({ project: {}, name: 'x' })).toEqual({ ok: true, options: { scale: 1, crf: 16, preset: 'medium', audio: true } });
  });

  it('rejects bad values with plain messages, one per option', () => {
    for (const scale of [0, -0.5, 1.5, '0.5', null]) expect(parseExportOptions({ scale }).ok, String(scale)).toBe(false);
    for (const crf of [-1, 52, 20.5, '20']) expect(parseExportOptions({ crf }).ok, String(crf)).toBe(false);
    expect(parseExportOptions({ preset: 'turbo' }).ok).toBe(false);
    expect(parseExportOptions({ audio: 'no' }).ok).toBe(false);
    const r = parseExportOptions({ scale: 2, crf: 99 });
    expect(r).toEqual({ ok: false, error: 'scale must be more than 0 and at most 1 (e.g. 0.5, or 50%); crf must be a whole number from 0 (best) to 51 (smallest file)' });
  });

  it('quality choices: Best CRF 16, Good CRF 20, Draft CRF 26 + veryfast', () => {
    expect(QUALITIES).toEqual({
      best: { label: 'Best (larger file)', crf: 16, preset: 'medium' },
      good: { label: 'Good', crf: 20, preset: 'medium' },
      draft: { label: 'Draft (fastest)', crf: 26, preset: 'veryfast' },
    });
  });

  it('Size labels show the live pixel size', () => {
    const uhd = { width: 3840, height: 2160 };
    expect(EXPORT_SCALES.map((s) => sizeLabel(uhd, s))).toEqual(['100% — 3840×2160', '50% — 1920×1080 (Full HD)', '25% — 960×540 (quick check)']);
    expect(EXPORT_SCALES.map((s) => sizeLabel({ width: 2160, height: 3840 }, s))).toEqual(['100% — 2160×3840', '50% — 1080×1920 (Full HD)', '25% — 540×960 (quick check)']);
    // Odd halves round to even sizes (libx264 + yuv420p need them).
    expect(EXPORT_SCALES.map((s) => sizeLabel({ width: 1366, height: 768 }, s))).toEqual(['100% — 1366×768', '50% — 684×384', '25% — 342×192 (quick check)']);
    expect(sizeLabel({ width: 1920, height: 1080 }, 1)).toBe('100% — 1920×1080 (Full HD)');
  });

  it('output size and fill scale: 1080×1350 @ 50% → 540×676, 1366×768 @ 50% → 684×384, 1920×1080 @ 25% → 480×270', () => {
    expect(exportSize({ width: 1080, height: 1350 }, 0.5)).toEqual({ outW: 540, outH: 676, scale: 676 / 1350 });
    expect(exportSize({ width: 1366, height: 768 }, 0.5)).toEqual({ outW: 684, outH: 384, scale: 684 / 1366 });
    expect(exportSize({ width: 1920, height: 1080 }, 0.25)).toEqual({ outW: 480, outH: 270, scale: 0.25 });
  });

  it('file name: name-WxH-stamp.mp4 with the output size and no characters Windows forbids', () => {
    const d = new Date('2026-10-06T01:18:57.123Z');
    expect(exportFileName('Promo', 1920, 1080, d)).toBe('Promo-1920x1080-2026-10-06T01-18-57.mp4');
    expect(exportFileName('', 684, 384, d)).toBe('untitled-684x384-2026-10-06T01-18-57.mp4');
    expect(exportFileName('Promo', 1920, 1080, d)).not.toMatch(/[<>:"/\\|?*]/);
  });
});

describe('two exports never share a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-exports-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = new Date('2026-10-06T01:18:57.900Z');
  const name = (n: number) => exportFileName('Promo', 640, 360, d, n);

  it('a second export in the same second gets -2, -3, …', () => {
    expect(name(1)).toBe('Promo-640x360-2026-10-06T01-18-57.mp4');
    expect(name(2)).toBe('Promo-640x360-2026-10-06T01-18-57-2.mp4');
    expect(name(3)).toBe('Promo-640x360-2026-10-06T01-18-57-3.mp4');
  });

  it('freeOutFile skips files on disk and files a running export is still writing (not on disk yet)', () => {
    const none = () => false;
    expect(freeOutFile(dir, name, none)).toBe(path.join(dir, name(1)));
    fs.writeFileSync(path.join(dir, name(1)), 'done');
    expect(freeOutFile(dir, name, none)).toBe(path.join(dir, name(2)));
    const writing = (f: string) => f === path.join(dir, name(2));
    expect(freeOutFile(dir, name, writing)).toBe(path.join(dir, name(3)));
    // With no export running, nothing is "in use".
    expect(isExportTarget(path.join(dir, name(2)))).toBe(false);
  });
});

describe('PNG still', () => {
  const p = at(1280, 720); // 1 s at 30 fps: frames 0–29

  it('saves the frame the playback bar shows: floor(t·fps), the last frame at the very end', () => {
    expect([0, 0.5, 0.51, 0.5 - 1e-9, 29 / 30, 1].map((t) => frameAt(p, t))).toEqual([0, 15, 15, 15, 29, 29]);
  });

  it('is named name-WxH-frameN.png at the project size; an unsaved project is "untitled"', () => {
    expect(stillFileName('Promo', p, 15)).toBe('Promo-1280x720-frame15.png');
    expect(stillFileName(null, p, 0)).toBe('untitled-1280x720-frame0.png');
  });
});

describe('ffmpeg command', () => {
  const index = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('defaults: project size, CRF 16, preset medium (the v1 command)', () => {
    const args = ffmpegArgs(at(1366, 768), '/out.mp4');
    expect([index(args, '-s'), index(args, '-crf'), index(args, '-preset')]).toEqual(['1366x768', '16', 'medium']);
  });

  it('the size, CRF and preset options reach ffmpeg (raw frames arrive at the output size)', () => {
    const args = ffmpegArgs(at(1366, 768), '/out.mp4', undefined, { scale: 0.5, crf: 26, preset: 'veryfast' });
    expect([index(args, '-s'), index(args, '-crf'), index(args, '-preset')]).toEqual(['684x384', '26', 'veryfast']);
    expect(index(ffmpegArgs(at(1080, 1350), '/o.mp4', undefined, { scale: 0.5 }), '-s')).toBe('540x676');
    // The colour-accurate conversion is kept for every size.
    expect(index(args, '-vf')).toContain('flags=accurate_rnd+full_chroma_int+full_chroma_inp');
  });
});

describe('CLI flags (npm run render)', () => {
  it('positional folder + output, flags in any order, both --flag value and --flag=value', () => {
    expect(parseRenderArgs(['A.motion', 'a.mp4'])).toEqual({ folder: 'A.motion', out: 'a.mp4', options: { scale: 1, crf: 16, preset: 'medium', audio: true } });
    expect(parseRenderArgs(['--scale', '0.5', 'A.motion', '--crf', '26', 'a.mp4', '--no-audio', '--preset=veryfast'])).toEqual({
      folder: 'A.motion',
      out: 'a.mp4',
      options: { scale: 0.5, crf: 26, preset: 'veryfast', audio: false },
    });
    expect(parseRenderArgs(['C:\\Users\\Me (Work)\\Promo.motion', 'D:\\out.mp4', '--scale=25%']).options.scale).toBe(0.25);
    expect(parseRenderArgs(['A', 'b', '--scale', '.5']).options.scale).toBe(0.5);
    expect(parseRenderArgs(['A', 'b', '--scale', '100%']).options.scale).toBe(1);
  });

  it('explains what is wrong', () => {
    const err = (argv: string[]) => {
      try {
        parseRenderArgs(argv);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(err(['A.motion'])).toBe('Give the project folder and the output file.');
    expect(err(['A', 'b', 'c'])).toBe('Unexpected argument: c');
    expect(err(['A', 'b', '--fast'])).toBe('Unknown option: --fast');
    expect(err(['A', 'b', '--scale'])).toBe('--scale needs a value');
    expect(err(['A', 'b', '--scale', '50'])).toBe('--scale must be more than 0 and at most 1 (e.g. 0.5, or 50%)');
    expect(err(['A', 'b', '--scale', 'half'])).toBe('--scale must be more than 0 and at most 1 (e.g. 0.5, or 50%)');
    expect(err(['A', 'b', '--crf', '60'])).toBe('--crf must be a whole number from 0 (best) to 51 (smallest file)');
    expect(err(['A', 'b', '--crf', '1e1'])).toBe('--crf must be a whole number from 0 (best) to 51 (smallest file)');
    expect(err(['A', 'b', '--preset', 'turbo'])).toMatch(/^--preset must be one of ultrafast, .*veryslow$/);
    expect(err(['A', 'b', '--no-audio=1'])).toBe('--no-audio takes no value');
  });
});

describe('remembered export choices (localStorage)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stored = (prefs: Record<string, unknown>) => vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(prefs), setItem: () => undefined });

  it('defaults to 100%, Best, with audio', () => {
    expect(loadPrefs()).toMatchObject({ exportScale: 1, exportQuality: 'best', exportAudio: true });
  });
  it('keeps valid saved choices and drops anything else', () => {
    stored({ exportScale: 0.25, exportQuality: 'draft', exportAudio: false });
    expect(loadPrefs()).toMatchObject({ exportScale: 0.25, exportQuality: 'draft', exportAudio: false });
    stored({ exportScale: 0.3, exportQuality: 'ultra', exportAudio: 'yes' });
    expect(loadPrefs()).toMatchObject({ exportScale: 1, exportQuality: 'best', exportAudio: true });
  });
});
