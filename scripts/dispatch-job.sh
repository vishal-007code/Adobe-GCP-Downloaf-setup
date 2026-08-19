#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════
#  CONFIGURE THESE before running
# ══════════════════════════════════════════════════════════
PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-asia-south1}"
REPO="${ARTIFACT_REPO:-adobe-automation}"
IMAGE_NAME="${IMAGE_NAME:-playwright-adobe}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE_NAME}:latest"
GCS_BUCKET="${GCS_BUCKET:?Set GCS_BUCKET}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"     # e.g. playwright-runner@PROJECT.iam.gserviceaccount.com

JOB_NAME="adobe-playwright-job"

# Batch tuning
TOTAL_ACCOUNTS=100
BATCH_SIZE="${BATCH_SIZE:-50}"             # accounts per Cloud Run task
PARALLELISM="${PARALLELISM:-2}"            # tasks running at the same time
WORKERS_PER_TASK="${WORKERS_PER_TASK:-3}"  # Chromium workers inside each task
MEMORY="${MEMORY:-4Gi}"
CPU="${CPU:-2}"
TASK_TIMEOUT="${TASK_TIMEOUT:-14400}"      # seconds (4 hours per task)
MAX_RETRIES="${MAX_RETRIES:-1}"
# ══════════════════════════════════════════════════════════

TASK_COUNT=$(( (TOTAL_ACCOUNTS + BATCH_SIZE - 1) / BATCH_SIZE ))

echo "╔══════════════════════════════════════════╗"
echo "  Adobe Playwright — Cloud Run Job Dispatch"
echo "╚══════════════════════════════════════════╝"
echo "  Project    : $PROJECT_ID"
echo "  Region     : $REGION"
echo "  Image      : $IMAGE"
echo "  Bucket     : $GCS_BUCKET"
echo "  Accounts   : $TOTAL_ACCOUNTS"
echo "  Batch size : $BATCH_SIZE accounts/task"
echo "  Tasks      : $TASK_COUNT"
echo "  Parallelism: $PARALLELISM"
echo "  Workers/task: $WORKERS_PER_TASK"
echo "  Memory     : $MEMORY  CPU: $CPU"
echo ""

# Upload accounts.csv to GCS (must be in current directory)
if [ -f "accounts.csv" ]; then
  echo "Uploading accounts.csv → gs://${GCS_BUCKET}/accounts.csv ..."
  gcloud storage cp accounts.csv "gs://${GCS_BUCKET}/accounts.csv" --project="$PROJECT_ID"
else
  echo "WARNING: accounts.csv not found locally — assuming it is already in GCS."
fi

ENV_VARS="GCS_BUCKET=${GCS_BUCKET},WORKERS=${WORKERS_PER_TASK}"

SA_FLAG=""
if [ -n "$SERVICE_ACCOUNT" ]; then
  SA_FLAG="--service-account=${SERVICE_ACCOUNT}"
fi

# Create or update the Cloud Run Job
if gcloud run jobs describe "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  echo "Updating existing job: $JOB_NAME ..."
  gcloud run jobs update "$JOB_NAME" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --image="$IMAGE" \
    --tasks="$TASK_COUNT" \
    --parallelism="$PARALLELISM" \
    --max-retries="$MAX_RETRIES" \
    --task-timeout="${TASK_TIMEOUT}s" \
    --memory="$MEMORY" \
    --cpu="$CPU" \
    --set-env-vars="$ENV_VARS" \
    $SA_FLAG
else
  echo "Creating new job: $JOB_NAME ..."
  gcloud run jobs create "$JOB_NAME" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --image="$IMAGE" \
    --tasks="$TASK_COUNT" \
    --parallelism="$PARALLELISM" \
    --max-retries="$MAX_RETRIES" \
    --task-timeout="${TASK_TIMEOUT}s" \
    --memory="$MEMORY" \
    --cpu="$CPU" \
    --set-env-vars="$ENV_VARS" \
    $SA_FLAG
fi

echo ""
echo "Executing job (this blocks until all tasks finish) ..."
gcloud run jobs execute "$JOB_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --wait

echo ""
echo "Job complete. Results are at: gs://${GCS_BUCKET}/results/"
echo "To download all CSVs locally:"
echo "  gcloud storage cp -r gs://${GCS_BUCKET}/results/ ./results/"
