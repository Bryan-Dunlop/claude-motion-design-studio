import type { Page } from '@playwright/test';
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
