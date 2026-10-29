import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Per-account upload of the downloaded PNG to Cloud Storage. OFF by default — the run
// only records that each download happened (see docs/run-report.md); this is the opt-in
// for keeping the PNGs themselves (ADOBE_DOWNLOADS_GCS_URI=gs://...).
//
// Cloud Run's disk is ephemeral and run-cloud-batch.sh used to copy ./downloads to GCS
// only at the END of a task (and only with SAVE_ARTIFACTS=true), so a task that hit its
// timeout or crashed lost every PNG it had made. Uploading inside the test, right after
// the download, means a PNG is in the bucket the moment its account passes — and if the
// upload fails the test fails, so the account is retried instead of silently missing.

const UPLOAD_ATTEMPTS = 3;
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Destination prefix for PNGs, e.g. gs://my-bucket/downloads (or a local directory, for
 * testing). Unset/empty = keep PNGs in ./downloads only, the default for local runs.
 * run-cloud-batch.sh sets it on Cloud Run.
 */
export function getDownloadsUploadUri(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.ADOBE_DOWNLOADS_GCS_URI?.trim();
  return raw ? raw.replace(/[\\/]+$/, '') : undefined;
}

/**
 * One fixed object name per account (<email>.png): a re-run can never create a second
 * copy, and `gcloud storage ls` maps straight back to the accounts CSV.
 */
export function downloadObjectName(email: string): string {
  return `${email.trim().toLowerCase()}.png`;
}

/**
 * Upload one PNG with `gcloud storage cp --no-clobber` (gcloud is in the image and picks
 * up the Cloud Run service account automatically). --no-clobber makes a re-run of an
 * account that already has its PNG a no-op success, and keeps the runner SA's
 * objectCreator role sufficient (overwriting would need delete permission).
 */
export async function uploadDownload(localPath: string, email: string, destPrefix: string): Promise<string> {
  const dest = `${destPrefix}/${downloadObjectName(email)}`;

  // A plain directory instead of gs:// (gcloud refuses local copies): same naming and
  // no-clobber rule, so the whole upload step can be exercised without a bucket.
  if (!destPrefix.startsWith('gs://')) {
    fs.mkdirSync(destPrefix, { recursive: true });
    try {
      fs.copyFileSync(localPath, dest, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return dest;
  }

  let lastError = '';

  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    const { code, output } = await run('gcloud', ['storage', 'cp', '--no-clobber', localPath, dest]);
    if (code === 0) return dest;

    lastError = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? `exit code ${code}`;
    console.log(`uploadDownload: attempt ${attempt}/${UPLOAD_ATTEMPTS} failed for ${path.basename(localPath)} — ${lastError}`);
    if (attempt < UPLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
  }

  throw new Error(`Upload to ${dest} failed after ${UPLOAD_ATTEMPTS} attempts: ${lastError}`);
}

function run(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // gcloud is a .cmd shim on Windows, which Node can only start through a shell —
    // so quote every argument there (the PNG names contain spaces and commas).
    const child = process.platform === 'win32'
      ? spawn([command, ...args.map((arg) => `"${arg.replace(/"/g, '""')}"`)].join(' '), { shell: true, windowsHide: true })
      : spawn(command, args);

    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });

    const timer = setTimeout(() => {
      output += `\ntimed out after ${UPLOAD_TIMEOUT_MS}ms`;
      child.kill();
    }, UPLOAD_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}
