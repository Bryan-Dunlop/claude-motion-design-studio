import { expect, type Page } from '@playwright/test';
import type { Project } from '../../src/shared/schema';

export const getState = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__motion.useEditor.getState();
    return { project: s.project as Project, time: s.time as number, dirty: s.project !== s.savedProject, missing: [...s.missingAssets] as string[], name: s.projectName as string | null };
  });

/** The comparable part of a project: scenes, layers, keyframes, settings, asset refs. */
export function comparable(p: Project) {
  return { schemaVersion: p.schemaVersion, settings: p.settings, scenes: p.scenes, assets: p.assets };
}

/** A layer by name from the current project (first match across scenes). */
export const layerOf = async (page: Page, name: string) => (await getState(page)).project.scenes.flatMap((s) => s.layers).find((l) => l.name === name)!;

/** Number of undo steps in the history. */
export const past = (page: Page) => page.evaluate(() => (window as any).__motion.useEditor.getState().past.length as number);

/** Drag with several intermediate moves (drags have a 2 px threshold), optionally holding a modifier. */
export async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number, modifiers: 'Shift' | 'Control' | null = null) {
  await page.mouse.move(from.x, from.y);
  if (modifiers) await page.keyboard.down(modifiers);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(from.x + (dx * i) / 6, from.y + (dy * i) / 6);
  await page.mouse.up();
  if (modifiers) await page.keyboard.up(modifiers);
}

/** Centre of an element by test id, in page coordinates. */
export const center = async (page: Page, testId: string) => {
  const b = (await page.getByTestId(testId).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** Open the render-only page (real canvas, fonts loaded, no editor UI). */
export async function openRenderPage(page: Page) {
  if (!page.url().includes('/render.html')) {
    await page.goto('/render.html');
    await expect(page).toHaveTitle('render-ready');
  }
}

/**
 * Run `fn` in the browser with a source module imported through Vite (e.g. '/src/shared/transitions.ts'), so
 * pixel-level "unit" tests can use a real Canvas (OffscreenCanvas) — Node has none. `fn` must be self-contained
 * (it is serialised); it receives the module and `arg`.
 */
export async function browserImport<T, A = undefined>(page: Page, modulePath: string, fn: (mod: any, arg: A) => T | Promise<T>, arg?: A): Promise<T> {
  await openRenderPage(page);
  return page.evaluate(
    async ({ modulePath, fnSrc, arg }) => {
      const mod = await import(/* @vite-ignore */ modulePath);
      // eslint-disable-next-line no-new-func
      const f = new Function(`return (${fnSrc})`)();
      return f(mod, arg);
    },
    { modulePath, fnSrc: fn.toString(), arg: arg as A },
  ) as Promise<T>;
}
