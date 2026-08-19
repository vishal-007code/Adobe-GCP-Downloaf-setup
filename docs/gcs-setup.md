# GCS Setup for Adobe Accounts

This repository can load Adobe accounts from Google Cloud Storage when it runs in Cloud Run.
The flow is:

1. Upload `accounts.csv` to a GCS bucket.
2. Give the Cloud Run runtime service account permission to read that object.
3. Set `ADOBE_ACCOUNTS_GCS_URI` so the container downloads the CSV at startup.

The GCS download path is implemented in [scripts/fetch-gcs-accounts.mjs](../scripts/fetch-gcs-accounts.mjs).

## What You Need

- A Google Cloud project with billing enabled.
- `gcloud` installed, or access to Google Cloud Shell.
- A CSV file named `accounts.csv` with this format:

```csv
email,password
user1@example.com,secret-1
user2@example.com,secret-2
```

## 1. Choose a Google Cloud project

```bash
gcloud config set project YOUR_PROJECT_ID
```

## 2. Enable the required APIs

```bash
gcloud services enable \
  storage.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

## 3. Create the bucket

Use a bucket name that is unique in GCS. The repo’s deploy script defaults to:

```text
<project-id>-adobe-accounts
```

Create it manually if you are not using the deploy script:

```bash
gcloud storage buckets create gs://YOUR_PROJECT_ID-adobe-accounts \
  --location=us-central1 \
  --uniform-bucket-level-access
```

## 4. Upload the account CSV

```bash
gcloud storage cp accounts.csv gs://YOUR_PROJECT_ID-adobe-accounts/accounts.csv
```

If you replace the CSV later, upload it again with the same path.

## 5. Grant the runtime service account read access

Pick the Cloud Run service account that will execute the job. If you do not set one explicitly, the deploy script uses the default compute service account.

```bash
gcloud iam service-accounts create playwright-runner \
  --display-name="Playwright Runner"
```

Then grant bucket read access:

```bash
gcloud storage buckets add-iam-policy-binding gs://YOUR_PROJECT_ID-adobe-accounts \
  --member="serviceAccount:playwright-runner@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
```

## 6. Point the container at the object

Use this environment variable in Cloud Run:

```bash
ADOBE_ACCOUNTS_GCS_URI=gs://YOUR_PROJECT_ID-adobe-accounts/accounts.csv
```

The container will download that object to the local path in `ADOBE_ACCOUNTS_CSV`.
In this repo’s Cloud Run job setup, that path is `/tmp/accounts.csv`.

## 7. Deploy with the provided script

This repo already includes a deployment script that performs the full setup:

```bash
bash scripts/deploy-gcp-cloud-run-job.sh
```

The script:

- Enables the required APIs.
- Creates the Artifact Registry repository if missing.
- Creates the GCS bucket if missing.
- Uploads `accounts.csv` to the bucket.
- Grants the runtime service account `roles/storage.objectViewer`.
- Builds the container image.
- Creates or updates the Cloud Run Job.
- Executes the job immediately.

You can override the defaults with environment variables:

```bash
export REGION=us-central1
export REPOSITORY=playwright-jobs
export IMAGE_NAME=adobe-login-flow
export JOB_NAME=adobe-login-flow
export ACCOUNTS_BUCKET=YOUR_PROJECT_ID-adobe-accounts
export OBJECT_NAME=accounts.csv
export ACCOUNTS_CSV=accounts.csv
export RUNTIME_SERVICE_ACCOUNT=playwright-runner@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

## 8. Run locally

For local runs, the GCS path is not the easiest option because the downloader expects the Cloud Run metadata server.

Use one of these instead:

```powershell
$env:ADOBE_ACCOUNTS_CSV="C:\path\to\accounts.csv"
npm run test:adobe
```

or place `accounts.csv` in the repo root and let the project pick it up automatically.

If you only have the file in GCS, download it locally first:

```bash
gcloud storage cp gs://YOUR_PROJECT_ID-adobe-accounts/accounts.csv ./accounts.csv
```

## 9. Verify the setup

When the Cloud Run Job works, the execution logs should eventually show:

```text
Login flow completed successfully
```

If the job fails, check these first:

- The object path in `ADOBE_ACCOUNTS_GCS_URI`.
- The bucket IAM binding for the runtime service account.
- The CSV header names, which must be `email,password`.
- Whether the runtime service account is the one you expected.

## Why This Setup Works

- `scripts/fetch-gcs-accounts.mjs` downloads the CSV from GCS at container startup.
- `src/adobe/accounts.ts` reads `ADOBE_ACCOUNTS_CSV` after the file is downloaded.
- `Dockerfile` runs the download before `npm run test:adobe`.

That keeps the account source outside the image and lets you rotate the CSV without rebuilding the code every time.
