// After `npm install`: note which package-lock.json is installed (Start Motion Studio.cmd installs again when it
// changes, e.g. after an update), then download the headless Chromium build that export uses (matches the pinned
// playwright version; only the headless shell, since everything runs headless).
// The download is skipped when PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set (e.g. CI images with browsers preinstalled).
import { spawnSync } from 'node:child_process';
import { installedStamp, STAMP_FILE } from './needs-install.mjs';
import fs from 'node:fs';

try {
  fs.writeFileSync(STAMP_FILE, installedStamp());
} catch {
  // No package-lock.json: the launcher just installs again next time.
}

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
  console.log('[motion-studio] PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set - not downloading Chromium.');
  process.exit(0);
}
const r = spawnSync('npx playwright install --only-shell chromium', { stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.warn('[motion-studio] Could not download Chromium automatically. Export needs it: run  npx playwright install --only-shell chromium');
}
