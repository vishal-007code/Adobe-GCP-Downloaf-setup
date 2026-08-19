import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { createAdobeRunId } from './src/adobe/runtime';

// Cloud Run / Linux-safe Playwright config. Kept separate from playwright.config.ts
// (which carries the Windows GPU/D3D11 launch args) because Chromium on Cloud Run
// runs as root on Linux and MUST launch with --no-sandbox and without GPU.
const adobeRunId = process.env.ADOBE_RUN_ID?.trim() || createAdobeRunId();
process.env.ADOBE_RUN_ID = adobeRunId;

// Worker count comes from ADOBE_PLAYWRIGHT_WORKERS (set by run-batches.sh / the job
// env), falling back to legacy WORKERS, then 3.
const WORKERS = parseInt(
  process.env.ADOBE_PLAYWRIGHT_WORKERS ?? process.env.WORKERS ?? '3',
  10,
);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: false,
  retries: 0,
  workers: WORKERS,
  reporter: [
    ['html'],
    [path.resolve(__dirname, 'src/adobe/reporter.ts')],
  ],
  timeout: 600_000,
  expect: {
    timeout: 120_000,
  },
  use: {
    actionTimeout: 120_000,
    navigationTimeout: 240_000,
    trace: 'off',
    screenshot: 'only-on-failure',
    headless: true,
    // channel:'chromium' runs the FULL Chromium in new-headless mode instead of
    // Playwright's default lightweight "headless shell".
    //
    // This matters because Google's SSO automation detection flags the shell far
    // more readily: on Cloud Run every account died waiting for the password field
    // ("locator.fill: Timeout 120000ms exceeded ... getByLabel('Enter your
    // password')") at a ~17% success rate, while the same code and accounts hit 86%
    // locally — where playwright.config.ts deliberately sets channel:'chromium' and
    // its own comment notes the shell "triggers banner". Sequential single-browser
    // runs failed identically, so it was never rate-limiting.
    //
    // Requires `npx playwright install chromium` in the Dockerfile, which supplies
    // the full build alongside the shell.
    channel: 'chromium',
    // Linux/Cloud Run compatible args — no GPU, no D3D11 (Windows-only).
    // --no-sandbox is required because the container runs as root.
    launchOptions: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  },
  projects: [
    {
      name: 'adobe-chromium',
      testMatch: /tests[\\/]adobe[\\/].+\.spec\.ts/,
      testIgnore: /tests[\\/]adobe[\\/].+\.low-network\.debug\.spec\.ts$/,
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
