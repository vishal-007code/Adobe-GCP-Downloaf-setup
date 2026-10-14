import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { createAdobeRunId } from './src/adobe/runtime';

const adobeRunId = process.env.ADOBE_RUN_ID?.trim() || createAdobeRunId();
const adobeLowNetworkDebugEnabled = process.env.ADOBE_LOW_NETWORK_DEBUG?.trim() === '1';
const adobeDebugSpecPattern = /tests[\\/]adobe[\\/].+\.low-network\.debug\.spec\.ts$/;
process.env.ADOBE_RUN_ID = adobeRunId;

// ──────────────────────────────────────────────────────────────────────────
// Bulk-run knobs — edit these two lines directly (no terminal variables needed).
//
//   BULK = true   → large account sweeps: traces off, more workers (faster).
//   BULK = false  → debugging: traces retained on failure, default worker count.
//
// Tests are network-bound (idle-waiting on Adobe), so WORKERS can safely exceed
// CPU core count. Watch RAM (~300-600MB per Chromium) and lower if it thrashes.
const BULK = true;
// Sweet spot is near physical core count (~6 here), NOT logical (12): the Adobe SPA
// has CPU/network-heavy bursts (app boot, editor load, generation) where concurrent
// workers contend and page loads slow down, pushing steps toward their timeouts.
// 4-6 is the realistic range on a 6-core/16GB box; tune empirically (see note below).
const WORKERS = 3;
// ──────────────────────────────────────────────────────────────────────────
// GPU MODE — Adobe Express shows "Performance limitations detected" (which stalls
// the publish/link spinner) when it can't get GPU acceleration.
//
//   'off'      → default headless SHELL: software rendering, NO GPU (triggers banner)
//   'headed'   → visible window using the real GPU; 1 worker, for a clean yes/no test
//   'headless' → new headless mode (channel:'chromium') WITH the GPU — no window,
//                GPU-capable, usable for bulk. THIS is the GPU-powered headless option.
//
// Why 'off' has no GPU: plain `headless:true` runs Chromium's lightweight headless
// SHELL, which renders in software. GPU needs the FULL browser in new headless mode,
// which Playwright selects via `channel: 'chromium'`.
const GPU_MODE = 'headless' as 'off' | 'headed' | 'headless';
// ──────────────────────────────────────────────────────────────────────────

// Windows: '--use-angle=d3d11' routes WebGL through DirectX (best GPU path here);
// '--ignore-gpu-blocklist' forces GPU even if the card is blocklisted by Chromium.
const GPU_ARGS = ['--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl', '--use-angle=d3d11'];

const adobeWorkers = GPU_MODE === 'headed' ? 1 : (BULK ? WORKERS : undefined);
// '--disable-blink-features=AutomationControlled' hides navigator.webdriver, the signal
// Google's federated sign-in keys off to reject the login with "Couldn't sign you in —
// This browser or app may not be secure" (it blocks at the EMAIL step, before credentials
// are ever checked). Without this flag the 2026-09-29 headless runs failed 100% on that
// block. Verified fix: with it, accounts pass in plain headless with parallel workers
// (3/3 in 37.8s), so no headed mode or worker-count sacrifice is needed.
const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
const adobeLaunchOptions = GPU_MODE === 'off' ? { args: STEALTH_ARGS } : { args: [...GPU_ARGS, ...STEALTH_ARGS] };

// GPU_MODE only means anything to Chromium: `channel: 'chromium'` selects the full
// browser in new headless mode, and GPU_ARGS are Chromium command-line flags. Keep
// them on the Chromium projects so the Firefox project doesn't inherit either.
const chromiumUse = {
  channel: (GPU_MODE === 'headless' ? 'chromium' : undefined) as 'chromium' | undefined,
  launchOptions: adobeLaunchOptions,
};

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : adobeWorkers,
  reporter: [
    ['html'],
    [path.resolve(__dirname, 'src/adobe/reporter.ts')],
  ],
  // Raised from 360s to fit the share→publish retry (EditorDashboard.sharePublishWithRetry).
  // A single pass of that leg can already reach ~360s on its own worst case (two 180s file-prep
  // waits), so a second attempt had no room under the old budget. sharePublishWithRetry checks
  // the remaining budget before starting a retry, so this ceiling bounds the retry rather than
  // being spent by default — passing accounts averaged 84s in the 2026-08-05 run.
  timeout: 600_000,
  expect:{
    timeout: 120_000,
  },
  use: {
    actionTimeout: 120_000,
    navigationTimeout: 240_000,
    trace: BULK ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: GPU_MODE !== 'headed',
  },
  projects: [
    {
      name: 'adobe-chromium',
      testMatch: adobeLowNetworkDebugEnabled
        ? adobeDebugSpecPattern
        : /tests[\\/]adobe[\\/].+\.spec\.ts/,
      testIgnore: adobeLowNetworkDebugEnabled ? undefined : adobeDebugSpecPattern,
      retries: 0,
      use: { ...devices['Desktop Chrome'], ...chromiumUse },
    },
    {
      // Same adobe specs on Firefox. GPU_MODE/GPU_ARGS do not apply here (Chromium-only),
      // so if Adobe Express complains about performance, run GPU_MODE = 'headed' instead.
      name: 'adobe-firefox',
      testMatch: adobeLowNetworkDebugEnabled
        ? adobeDebugSpecPattern
        : /tests[\\/]adobe[\\/].+\.spec\.ts/,
      testIgnore: adobeLowNetworkDebugEnabled ? undefined : adobeDebugSpecPattern,
      retries: 0,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'internal-chromium',
      testMatch: /tests[\\/]internal[\\/].+\.spec\.ts/,
      retries: 0,
      use: { ...devices['Desktop Chrome'], ...chromiumUse },
    },
  ],
});
