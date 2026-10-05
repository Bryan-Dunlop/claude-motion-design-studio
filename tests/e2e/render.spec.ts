// Determinism in the real browser: rendering the same t twice gives identical pixels.
import { expect, test } from '@playwright/test';
import { sampleProject } from '../fixtures/sampleProject';

test('renderFrame is pixel-deterministic in Chromium', async ({ page }) => {
  await page.goto('/render.html');
  await expect(page).toHaveTitle('render-ready');
  const project = sampleProject();
  for (const t of [0, 0.5, 1.0, 1.73, 6]) {
    const [a, b] = await page.evaluate(
      async ({ p, t }) => {
        const m = (window as any).motion;
        return [await m.render(p, t), await m.render(p, t)];
      },
      { p: project, t },
    );
    expect(a.sha256).toBe(b.sha256);
  }
  // Different times produce different pixels (sanity: the animation actually moves).
  const [x, y] = await page.evaluate(async (p) => {
    const m = (window as any).motion;
    return [(await m.render(p, 0.2)).sha256, (await m.render(p, 1.2)).sha256];
  }, project);
  expect(x).not.toBe(y);
});
