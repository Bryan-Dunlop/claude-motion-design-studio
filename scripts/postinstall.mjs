// Download the headless Chromium build that export uses (matches the pinned playwright version).
// Skipped when PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set (e.g. CI images with browsers preinstalled).
import { spawnSync } from 'node:child_process';

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
  console.log('[motion-studio] PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set - not downloading Chromium.');
  process.exit(0);
}
const r = spawnSync('npx playwright install chromium', { stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.warn('[motion-studio] Could not download Chromium automatically. Export needs it: run  npx playwright install chromium');
}
