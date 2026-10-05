// Output size for an export at `exportScale` (1 = 100%): even dimensions (libx264 + yuv420p reject odd sizes) and the
// renderFrame scale that fills them (never an unpainted edge; at most a 1 px crop).
import type { Settings } from './schema';

export function exportSize(settings: Pick<Settings, 'width' | 'height'>, exportScale = 1): { outW: number; outH: number; scale: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const outW = even(settings.width * exportScale);
  const outH = even(settings.height * exportScale);
  return { outW, outH, scale: Math.max(outW / settings.width, outH / settings.height) };
}
