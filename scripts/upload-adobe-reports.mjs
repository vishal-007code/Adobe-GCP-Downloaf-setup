import fs from 'node:fs';
import path from 'node:path';

const reportsGcsUri = process.env.ADOBE_REPORTS_GCS_URI?.trim();
if (!reportsGcsUri) {
  console.log('[UPLOAD] ADOBE_REPORTS_GCS_URI is not set. Skipping upload.');
  process.exit(0);
}

const runId = process.env.ADOBE_RUN_ID?.trim() || 'unknown-run';
const taskIndex = process.env.CLOUD_RUN_TASK_INDEX?.trim() || '0';

const match = /^gs:\/\/([^/]+)(?:\/(.*))?$/.exec(reportsGcsUri);
if (!match) {
  throw new Error(`ADOBE_REPORTS_GCS_URI must use the form gs://bucket/prefix, got: ${reportsGcsUri}`);
}

const bucket = match[1];
const basePrefix = (match[2] ?? '').replace(/\/$/, '');
const runPrefix = [basePrefix, `run-${runId}`, `task-${taskIndex}`].filter(Boolean).join('/');

console.log(`[UPLOAD] Upload destination: gs://${bucket}/${runPrefix}`);

const directReportFiles = [
  {
    localPath: process.env.ADOBE_RESULTS_PATH?.trim(),
    remoteName: 'results.csv',
    contentType: 'text/csv; charset=utf-8',
  },
  {
    localPath: process.env.ADOBE_CONSUMED_LEDGER_PATH?.trim(),
    remoteName: 'consumed_accounts.csv',
    contentType: 'text/csv; charset=utf-8',
  },
  {
    localPath: process.env.ADOBE_REPORT_SUMMARY_PATH?.trim(),
    remoteName: 'summary.json',
    contentType: 'application/json; charset=utf-8',
  },
].filter((file) => file.localPath && fs.existsSync(file.localPath));

const artifactFiles = [
  ...collectDirectoryFiles('test-results', 'playwright-artifacts/test-results'),
  ...collectDirectoryFiles('playwright-report', 'playwright-artifacts/playwright-report'),
];

const files = [
  ...directReportFiles.map((file) => ({
    localPath: file.localPath,
    remotePath: [runPrefix, file.remoteName].filter(Boolean).join('/'),
    contentType: file.contentType,
  })),
  ...artifactFiles.map((file) => ({
    localPath: file.localPath,
    remotePath: [runPrefix, file.remotePath].filter(Boolean).join('/'),
    contentType: guessContentType(file.localPath),
  })),
];

if (files.length === 0) {
  console.log(`[UPLOAD] No report or Playwright artifact files found to upload for gs://${bucket}/${runPrefix}.`);
  process.exit(0);
}

console.log(`[UPLOAD] Found ${directReportFiles.length} report file(s).`);
console.log(`[UPLOAD] Found ${artifactFiles.length} Playwright artifact file(s).`);

const token = await getAccessToken();

let uploadedCount = 0;

for (const file of files) {
  const uploadUrl = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
  uploadUrl.searchParams.set('uploadType', 'media');
  uploadUrl.searchParams.set('name', file.remotePath);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': file.contentType,
    },
    body: fs.readFileSync(file.localPath),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to upload ${file.localPath} to gs://${bucket}/${file.remotePath}: ` +
      `${response.status} ${response.statusText} ${body}`,
    );
  }

  uploadedCount += 1;
  console.log(`[UPLOAD] Uploaded ${file.localPath} to gs://${bucket}/${file.remotePath}`);
}

console.log(`[UPLOAD] Upload complete. Uploaded ${uploadedCount} file(s).`);

function collectDirectoryFiles(localDir, remoteDir) {
  if (!fs.existsSync(localDir)) {
    console.log(`[UPLOAD] Directory not found: ${localDir}`);
    return [];
  }

  const files = [];

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path.relative(localDir, fullPath).split(path.sep).join('/');
      files.push({
        localPath: fullPath,
        remotePath: `${remoteDir}/${relativePath}`,
      });
    }
  }

  walk(localDir);
  return files;
}

function guessContentType(filePath) {
  const lower = filePath.toLowerCase();

  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.js')) return 'application/javascript; charset=utf-8';

  return 'application/octet-stream';
}

async function getAccessToken() {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    {
      headers: {
        'Metadata-Flavor': 'Google',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to read metadata server token: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();

  if (!payload.access_token) {
    throw new Error('Metadata server response did not include an access_token.');
  }

  return payload.access_token;
}