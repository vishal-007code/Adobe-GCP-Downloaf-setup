# Run the Adobe Login Flow on GCP

Use a Cloud Run Job for this project. It runs the Playwright container once, prints `Login flow completed successfully` when the login flow reaches the current stop point, then exits.

## Prerequisites

- A Google Cloud project with billing enabled.
- Google Cloud Shell, or a machine with `gcloud` installed.
- An `accounts.csv` file with this format:

```csv
email,password
user@example.com,password
```

Do not commit `accounts.csv`. It is excluded from Git and from the Docker image.

## Deploy from Google Cloud Shell

1. Open Google Cloud Shell.
2. Clone or upload this repository.
3. Put `accounts.csv` in the repository root.
4. Select your project:

```bash
gcloud config set project YOUR_PROJECT_ID
```

5. Run the deploy script:

```bash
bash scripts/deploy-gcp-cloud-run-job.sh
```

The script will:

- Enable Cloud Run, Cloud Build, Artifact Registry, and Cloud Storage APIs.
- Create an Artifact Registry Docker repository named `playwright-jobs` if missing.
- Create a Cloud Storage bucket named `<project-id>-adobe-accounts` if missing.
- Upload `accounts.csv` to `gs://<project-id>-adobe-accounts/accounts.csv`.
- Grant the Cloud Run runtime service account read access to that bucket object.
- Build and push the Docker image.
- Create or update a Cloud Run Job named `adobe-login-flow`.
- Execute the job immediately.

## Optional Settings

Set these environment variables before running the script to override defaults:

```bash
export REGION=us-central1
export REPOSITORY=playwright-jobs
export IMAGE_NAME=adobe-login-flow
export JOB_NAME=adobe-login-flow
export ACCOUNTS_BUCKET=new-adobe-type-adobe-accounts
export OBJECT_NAME=accounts.csv
export ACCOUNTS_CSV=accounts.csv
export TASKS=1
export PARALLELISM=1
export TASK_TIMEOUT=30m
export CPU=2
export MEMORY=2Gi
export ADOBE_PLAYWRIGHT_WORKERS=1
export ADOBE_STOP_AFTER_LOGIN=0
export GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/...
export GOOGLE_CHAT_THREAD_KEY=adobe-login-flow-20260511
export REPORTS_BUCKET=new-adobe-type-adobe-accounts
export REPORTS_OBJECT_PREFIX=adobe-runs
```

If your project uses a custom Cloud Run service account:

```bash
export RUNTIME_SERVICE_ACCOUNT=my-service-account@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

## Check the Result

The deploy script waits for the job execution. In the Cloud Run execution logs, look for:

```text
Login flow completed successfully
```

You can re-run the job without rebuilding:

```bash
gcloud run jobs execute adobe-login-flow --region=us-central1 --wait
```

If you change code, run the deploy script again so a new image is built and deployed.

## Check Billing

To check the real charge for the run, open your Cloud Billing account and use the Cost table report.
Filter by the project that ran the job and by `Cloud Run` service to see the usage that maps to this job.

Cloud Run pricing is pay-per-use and rounded up to the nearest 100 ms. Current list pricing on the Cloud Run page is:

- CPU: `$0.00001800 / vCPU-second`
- Memory: `$0.00000200 / GiB-second`

## Notes

- Cloud Run Job retries are set to `0` because this project treats accounts as consumable inputs.
- The job runs with one task and one worker by default.
- Runtime reports are created inside the container filesystem. They are visible in logs/artifacts during that execution, but not persisted after the container exits. Persisting reports to Cloud Storage would need a small follow-up change.
- The deploy script can post start, success, and failure updates to Google Chat when `GOOGLE_CHAT_WEBHOOK_URL` is set.
- The deploy script prints a Cloud Run cost estimate based on CPU, memory, task count, and parallelism.
- The deploy script also uploads merged report CSVs and a summary JSON to `gs://<reports-bucket>/<prefix>/run-<run-id>/task-<index>/`.

References:

- Cloud Run Jobs: https://cloud.google.com/run/docs/create-jobs
- Cloud Run pricing: https://cloud.google.com/run
- Cloud Billing cost table: https://cloud.google.com/billing/docs/how-to/cost-table
- Cloud Storage buckets: https://cloud.google.com/storage/docs/
- Artifact Registry Docker images: https://cloud.google.com/artifact-registry/docs/docker/store-docker-container-images
