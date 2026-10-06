// Command-line arguments of `npm run render` (pure, unit-tested).
import { parseExportOptions, type ExportOptions } from '../src/shared/exportSize';

export const RENDER_USAGE = [
  'Usage: npm run render -- <projectFolder.motion> <out.mp4> [options]',
  '  --scale <s>     output size: 1 (default), 0.5 or 50%, 0.25 or 25%, …',
  '  --crf <n>       quality, 0–51: 16 = best (default), 20 = good, 26 = draft',
  '  --preset <p>    x264 speed: medium (default), veryfast (draft), …',
  '  --no-audio      leave the audio clips out',
].join('\n');

export interface RenderArgs {
  folder: string;
  out: string;
  options: ExportOptions;
}

/** "0.5" → 0.5, "50%" → 0.5 (anything else → NaN, rejected by the options schema). */
function parseScale(v: string): number {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(%?)$/.exec(v.trim());
  if (!m) return NaN;
  return m[2] ? Number(m[1]) / 100 : Number(m[1]);
}

/** Parse `<folder> <out> [--scale s] [--crf n] [--preset p] [--no-audio]`. Throws an Error with a plain message. */
export function parseRenderArgs(argv: string[]): RenderArgs {
  const positional: string[] = [];
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === '--no-audio') {
      if (eq > 0) throw new Error('--no-audio takes no value');
      raw.audio = false;
      continue;
    }
    if (!['--scale', '--crf', '--preset'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') throw new Error(`${flag} needs a value`);
    if (flag === '--scale') raw.scale = parseScale(value);
    else if (flag === '--crf') raw.crf = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
    else raw.preset = value;
  }
  if (positional.length < 2) throw new Error('Give the project folder and the output file.');
  if (positional.length > 2) throw new Error(`Unexpected argument: ${positional[2]}`);
  const parsed = parseExportOptions(raw);
  if (!parsed.ok) throw new Error(parsed.error.replace(/(^|; )(scale|crf|preset)/g, '$1--$2'));
  return { folder: positional[0], out: positional[1], options: parsed.options };
}
