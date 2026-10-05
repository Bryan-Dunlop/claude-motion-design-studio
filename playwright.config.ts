import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5199);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1500, height: 950 },
    // Same flags as the exporter's Chromium so the test browser rasterises like the export does.
    launchOptions: { args: ['--force-color-profile=srgb', '--disable-gpu'] },
  },
  webServer: {
    command: 'npx tsx server/dev.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { PORT: String(PORT), MOTION_WORKSPACE: '.e2e-workspace' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
