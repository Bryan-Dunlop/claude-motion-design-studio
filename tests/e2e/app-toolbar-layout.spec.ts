// Toolbar and playback bar stay on one line at common window sizes: a long project name is cut with an ellipsis (the
// full name is in its tooltip) instead of pushing "Export MP4" onto a second row, and the playback labels never wrap.
import { expect, test, type Page } from '@playwright/test';

/** Open a project called `name` with an unsaved change (● dot), as after "Make a copy in another format". */
async function nameProject(page: Page, name: string) {
  await page.evaluate((n) => {
    const st = (window as any).__motion.useEditor.getState();
    st.loadProject(st.project, n);
    st.commit((d: any) => void (d.settings.background = '#000001'));
  }, name);
  await expect(page.getByTestId('dirty-dot')).toBeVisible();
}

async function layout(page: Page) {
  return page.evaluate(() => {
    const r = (el: Element) => el.getBoundingClientRect();
    const tb = document.querySelector('.toolbar')!;
    const pb = document.querySelector('.playback')!;
    const shown = [...pb.children].filter((c) => (c as HTMLElement).offsetParent !== null);
    const name = document.querySelector('[data-testid=doc-name] .doc-title') as HTMLElement | null;
    return {
      toolbarHeight: Math.round(r(tb).height),
      toolbarRows: new Set([...tb.querySelectorAll('button')].map((b) => Math.round(r(b).top))).size,
      toolbarFits: tb.scrollWidth <= tb.clientWidth,
      playbackHeight: Math.round(r(pb).height),
      playbackRows: new Set(shown.map((c) => Math.round(r(c).top + r(c).height / 2))).size,
      tallestPlaybackItem: Math.max(...shown.map((c) => Math.round(r(c).height))),
      playbackFits: pb.scrollWidth <= pb.clientWidth,
      nameCut: name ? name.scrollWidth > name.clientWidth : null,
      // Nothing is pushed out of the window (Export MP4 and the Properties panel stay fully visible).
      insideWindow: ['.toolbar', '[data-testid=btn-export]', '.right-panel', '.playback'].every((sel) => r(document.querySelector(sel)!).right <= window.innerWidth + 0.5),
    };
  });
}

const one = { toolbarRows: 1, toolbarFits: true, playbackRows: 1, playbackFits: true, insideWindow: true };

test.describe('at 1280×720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('a 19-character name with unsaved changes keeps the toolbar on one row; the playback bar is one line', async ({ page }) => {
    await page.goto('/');
    await nameProject(page, 'Flowly launch promo');
    const m = await layout(page);
    expect(m).toMatchObject({ ...one, nameCut: false });
    expect(m.toolbarHeight).toBeLessThanOrEqual(42);
    expect(m.tallestPlaybackItem).toBeLessThanOrEqual(28);
    expect(m.playbackHeight).toBeLessThanOrEqual(40);
    await expect(page.getByTestId('doc-name')).toHaveAttribute('title', 'Flowly launch promo');
    // No room for the frame counter here: the timecode's tooltip gives the frame.
    await expect(page.getByTestId('frame-counter')).toBeHidden();
    await expect(page.getByTestId('timecode')).toHaveAttribute('title', /frame 0 \/ 449/);
    await page.screenshot({ path: test.info().outputPath('toolbar-1280.png') });
  });

  test('a very long name is cut with an ellipsis, the full name is in its tooltip', async ({ page }) => {
    await page.goto('/');
    const long = 'Flowly product launch promo — final cut for the website (v12)';
    await nameProject(page, long);
    expect(await layout(page)).toMatchObject({ ...one, nameCut: true });
    await expect(page.getByTestId('doc-name')).toHaveAttribute('title', long);
    await expect(page.getByTestId('doc-name')).toHaveText(`●${long}`);
    await page.screenshot({ path: test.info().outputPath('toolbar-1280-long.png') });
  });
});

test.describe('at 1920×1080', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('one toolbar row and one playback line with the frame counter shown', async ({ page }) => {
    await page.goto('/');
    await nameProject(page, 'Flowly launch promo 9x16');
    const m = await layout(page);
    expect(m).toMatchObject({ ...one, nameCut: false });
    expect(m.toolbarHeight).toBeLessThanOrEqual(42);
    expect(m.playbackHeight).toBeLessThanOrEqual(40);
    await expect(page.getByTestId('frame-counter')).toBeVisible();
    await expect(page.getByTestId('frame-counter')).toHaveText('frame 0 / 449');
    await page.screenshot({ path: test.info().outputPath('toolbar-1920.png') });
  });
});
