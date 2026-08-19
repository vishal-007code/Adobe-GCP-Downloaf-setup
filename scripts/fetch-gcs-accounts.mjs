import fs from 'node:fs';
import path from 'node:path';

const gcsUri = process.env.ADOBE_ACCOUNTS_GCS_URI?.trim();
if (!gcsUri) {
  process.exit(0);
}

const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(gcsUri);
if (!match) {
  throw new Error(`ADOBE_ACCOUNTS_GCS_URI must use the form gs://bucket/object, got: ${gcsUri}`);
}

const bucket = match[1];
const objectName = match[2];
const outputPath = path.resolve(process.cwd(), process.env.ADOBE_ACCOUNTS_CSV?.trim() || 'accounts.csv');

const token = await getAccessToken();
const objectUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
const response = await fetch(objectUrl, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

if (!response.ok) {
  throw new Error(`Failed to download ${gcsUri}: ${response.status} ${response.statusText}`);
}

const csv = await response.text();
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, csv, 'utf8');
console.log(`Downloaded ${gcsUri} to ${outputPath}`);

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
