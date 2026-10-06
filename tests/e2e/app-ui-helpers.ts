// Helpers for the B2 editor-UX tests (keyframes, snapping, menus, layout).
import { expect, type Page } from '@playwright/test';
import { getState } from './helpers';

/** Run `src` with `s` = the editor store state (e.g. 's.setTime(2)'). */
export const store = (page: Page, src: string) => page.evaluate((code) => new Function('s', code)((window as any).__motion.useEditor.getState()), src);

export const setTime = (page: Page, t: number) => store(page, `s.setTime(${t})`);

export const editor = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__motion.useEditor.getState();
    return { selectedKeys: s.selectedKeys as string[], selection: s.selection as { sceneId: string | null; layerIds: string[]; audioIds: string[] }, zoom: s.zoom as number, time: s.time as number };
  });

/** Type into a number/text field and commit with Enter. */
export async function setNumber(page: Page, testId: string, value: string) {
  await page.getByTestId(testId).fill(value);
  await page.getByTestId(testId).press('Enter');
}

/** Press a shortcut the way a user does: not while a form field has focus. */
export async function shortcut(page: Page, keys: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(keys);
}

/** Layers of the current project by name (first scene that has one). */
export const layersByName = async (page: Page) => Object.fromEntries((await getState(page)).project.scenes.flatMap((s) => s.layers).map((l) => [l.name, l]));

/** Keyframe [time, value] pairs of one property of a layer. */
export const track = async (page: Page, layer: string, prop: string) => ((await layersByName(page))[layer]?.keyframes[prop] ?? []).map((k) => [round(k.time), k.value]);

export const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Toast with this exact text is visible. */
export const toast = (page: Page, text: string) => expect(page.locator('.toast').filter({ hasText: text }).first()).toBeVisible();

/** Preview geometry: project px → page px. */
export async function previewMap(page: Page) {
  const b = (await page.getByTestId('preview-canvas').boundingBox())!;
  const { width } = (await getState(page)).project.settings;
  const k = width / b.width; // project px per screen px
  return { box: b, k, toScreen: (x: number, y: number) => ({ x: b.x + x / k, y: b.y + y / k }) };
}

/** Press, move in steps (drags have a 2 px threshold) and keep the button down; returns `release`. */
export async function startDragAt(page: Page, from: { x: number; y: number }, dx: number, dy: number, modifier: 'Shift' | 'Control' | null = null) {
  await page.mouse.move(from.x, from.y);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(from.x + (dx * i) / 6, from.y + (dy * i) / 6);
  return async () => {
    await page.mouse.up();
    if (modifier) await page.keyboard.up(modifier);
  };
}
