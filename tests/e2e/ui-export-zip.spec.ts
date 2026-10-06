// Export MP4 through the dialog (progress -> download), and .zip export/import round trip.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { comparable, getState } from './helpers';

const FIXTURE = path.resolve('tests/fixtures/fixture.png');

test('Export MP4 dialog shows progress and offers the file', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-text').click();
  // Small, short project so the test is quick.
  await page.keyboard.press('Escape');
  await page.getByTestId('setting-duration').fill('1');
  await page.getByTestId('setting-duration').press('Enter');
  await page.getByTestId('setting-width').fill('640');
  await page.getByTestId('setting-width').press('Enter');
  await page.getByTestId('setting-height').fill('360');
  await page.getByTestId('setting-height').press('Enter');
  await page.getByTestId('btn-export').click();
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-status')).toContainText('done', { timeout: 60_000 });
  await expect(page.getByTestId('export-status')).toContainText('30/30');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()]);
  const file = test.info().outputPath('ui.mp4');
  await download.saveAs(file);
  expect(fs.readFileSync(file).subarray(4, 8).toString()).toBe('ftyp');
});

test('project .zip export and import round-trips', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('layer-item-fixture')).toBeVisible();
  await page.getByTestId('add-text').click();
  const before = (await getState(page)).project;
  // Export .zip lives in the File ▾ menu.
  await page.getByTestId('file-menu').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('file-export-zip').click()]);
  await expect(page.getByTestId('file-menu-list')).toHaveCount(0); // picking an item closes the menu
  const zip = test.info().outputPath(`Zip ${Date.now()}.motion.zip`);
  await download.saveAs(zip);

  page.on('dialog', (d) => d.accept()); // "discard unsaved changes?"
  await page.getByRole('button', { name: 'New' }).click();
  expect((await getState(page)).project.scenes).toHaveLength(0);
  // File ▾ → Import .zip opens the file picker for .zip files.
  await page.getByTestId('file-menu').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('file-import-zip').click()]);
  await expect(page.locator('input[type=file][accept=".zip"]')).toHaveCount(1);
  await chooser.setFiles(zip);
  await expect.poll(async () => (await getState(page)).name).toMatch(/^Zip \d+/);
  const after = await getState(page);
  expect(comparable(after.project)).toEqual(comparable(before));
  await expect.poll(async () => (await getState(page)).missing).toEqual([]);
});
