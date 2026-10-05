// Browser-only: decode images and register fonts so renderFrame can draw synchronously.
import type { Project } from './schema';
import type { RenderResources } from './renderFrame';

export const BUILTIN_FONTS = ['Inter', 'sans-serif', 'serif', 'monospace'];

const fontCache = new Map<string, Promise<void>>();
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(url);
  if (!p) {
    p = (async () => {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      try {
        await img.decode();
        return img;
      } catch {
        return null;
      }
    })();
    imageCache.set(url, p);
    // Don't cache failures forever: a relink/save may make the URL valid later.
    p.then((r) => r === null && imageCache.delete(url));
  }
  return p;
}

function loadFont(family: string, url: string): Promise<void> {
  const key = `${family}|${url}`;
  let p = fontCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const face = new FontFace(family, `url("${url}")`);
        await face.load();
        document.fonts.add(face);
      } catch {
        fontCache.delete(key);
      }
    })();
    fontCache.set(key, p);
  }
  return p;
}

/** Load every asset the project references. Missing files simply stay absent (placeholder drawn). */
export async function loadResources(project: Project, urlFor: (assetId: string) => string): Promise<RenderResources & { missing: Set<string> }> {
  const images = new Map<string, CanvasImageSource>();
  const missing = new Set<string>();
  await Promise.all(
    project.assets.map(async (a) => {
      const url = urlFor(a.id);
      if (a.type === 'font') {
        await loadFont(a.fontFamily ?? a.id, url);
        const ok = [...document.fonts].some((f) => f.family.replace(/"/g, '') === (a.fontFamily ?? a.id) && f.status === 'loaded');
        if (!ok) missing.add(a.id);
      } else {
        const img = await loadImage(url);
        if (img) images.set(a.id, img);
        else missing.add(a.id);
      }
    }),
  );
  // Make sure the built-in font (and every weight used) is ready before the first frame.
  const loads: Promise<unknown>[] = [];
  for (const scene of project.scenes)
    for (const l of scene.layers)
      if (l.type === 'text') loads.push(document.fonts.load(`${l.fontWeight} 32px "${l.fontFamily}"`).catch(() => undefined));
  await Promise.all(loads);
  await document.fonts.ready;
  return { images, missing };
}
