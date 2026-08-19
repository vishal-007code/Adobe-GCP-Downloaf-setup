#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-asia-south1}"

REPOSITORY="${REPOSITORY:-playwright-jobs}"
IMAGE_NAME="${IMAGE_NAME:-adobe-login-flow}"
JOB_NAME="${JOB_NAME:-adobe-login-flow}"

ACCOUNTS_BUCKET="${ACCOUNTS_BUCKET:-${PROJECT_ID}-adobe-accounts}"
OBJECT_NAME="${OBJECT_NAME:-accounts.csv}"
ACCOUNTS_CSV="${ACCOUNTS_CSV:-accounts.csv}"

REPORTS_BUCKET="${REPORTS_BUCKET:-${ACCOUNTS_BUCKET}}"
REPORTS_OBJECT_PREFIX="${REPORTS_OBJECT_PREFIX:-adobe-runs}"

TASKS="${TASKS:-1}"
PARALLELISM="${PARALLELISM:-1}"
TASK_TIMEOUT="${TASK_TIMEOUT:-3h}"

CPU="${CPU:-2}"
MEMORY="${MEMORY:-8Gi}"

ADOBE_PLAYWRIGHT_WORKERS="${ADOBE_PLAYWRIGHT_WORKERS:-2}"
ADOBE_STOP_AFTER_LOGIN="${ADOBE_STOP_AFTER_LOGIN:-0}"
ADOBE_STOP_AFTER_LETS_GO="${ADOBE_STOP_AFTER_LETS_GO:-0}"
ADOBE_SCRIPT_ACCOUNT_LIMIT="${ADOBE_SCRIPT_ACCOUNT_LIMIT:-21}"
ADOBE_LETS_GO_APPEAR_TIMEOUT_MS="${ADOBE_LETS_GO_APPEAR_TIMEOUT_MS:-60000}"
ADOBE_STRICT_LETS_GO="${ADOBE_STRICT_LETS_GO:-1}"
ADOBE_VIDEO_MODE="${ADOBE_VIDEO_MODE:-off}"
ADOBE_DEBUG_ARTIFACTS="${ADOBE_DEBUG_ARTIFACTS:-0}"
SAVE_ARTIFACTS="${SAVE_ARTIFACTS:-false}"

GOOGLE_CHAT_WEBHOOK_URL="${GOOGLE_CHAT_WEBHOOK_URL:-}"
TOTAL_ACCOUNTS="${TOTAL_ACCOUNTS:-}"
AVG_SECONDS_PER_ACCOUNT="${AVG_SECONDS_PER_ACCOUNT:-10}"

TAG="${TAG:-$(date +%Y%m%d%H%M%S)}"
GOOGLE_CHAT_THREAD_KEY="${GOOGLE_CHAT_THREAD_KEY:-${JOB_NAME}-${TAG}}"

CURRENT_STAGE="initializing"

log() {
  echo "[DEPLOY][$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

notify_chat() {
  local message="$1"

  if [[ -z "${GOOGLE_CHAT_WEBHOOK_URL}" ]]; then
    return 0
  fi

  GOOGLE_CHAT_WEBHOOK_URL="${GOOGLE_CHAT_WEBHOOK_URL}" \
  GOOGLE_CHAT_MESSAGE="${message}" \
  GOOGLE_CHAT_THREAD_KEY="${GOOGLE_CHAT_THREAD_KEY}" \
  node scripts/send-google-chat-update.mjs >/dev/null || true
}

on_error() {
  local exit_code="$1"
  local stage="$2"

  log "ERROR: Cloud Run job ${JOB_NAME} failed during stage: ${stage}. Exit code: ${exit_code}"
  notify_chat "Cloud Run job ${JOB_NAME} failed during ${stage} in ${REGION}. Exit code ${exit_code}." || true

  echo
  echo "Useful debug commands:"
  echo "gcloud run jobs describe ${JOB_NAME} --region=${REGION} --project=${PROJECT_ID}"
  echo "gcloud logging read 'resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${JOB_NAME}\"' --project=${PROJECT_ID} --limit=100 --format='value(timestamp,textPayload)'"
  echo

  exit "${exit_code}"
}

trap 'on_error $? "$CURRENT_STAGE"' ERR

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "ERROR: PROJECT_ID is not set."
  echo "Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

if [[ ! -f "${ACCOUNTS_CSV}" ]]; then
  echo "ERROR: Account CSV not found at ${ACCOUNTS_CSV}."
  echo "Expected CSV columns: email,password"
  exit 1
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-playwright-runner@${PROJECT_ID}.iam.gserviceaccount.com}"

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"
ACCOUNTS_URI="gs://${ACCOUNTS_BUCKET}/${OBJECT_NAME}"
REPORTS_URI="gs://${REPORTS_BUCKET}/${REPORTS_OBJECT_PREFIX}"

if [[ -f scripts/estimate-cloud-run-cost.mjs ]]; then
  run_cost_summary="$(CPU="${CPU}" MEMORY="${MEMORY}" TASKS="${TASKS}" PARALLELISM="${PARALLELISM}" TOTAL_ACCOUNTS="${TOTAL_ACCOUNTS}" AVG_SECONDS_PER_ACCOUNT="${AVG_SECONDS_PER_ACCOUNT}" node scripts/estimate-cloud-run-cost.mjs || true)"
else
  run_cost_summary="Cost estimate script not found."
fi

log "============================================================"
log "Adobe Playwright Cloud Run Job Deployment"
log "============================================================"
log "Project ID: ${PROJECT_ID}"
log "Project number: ${PROJECT_NUMBER}"
log "Region: ${REGION}"
log "Repository: ${REPOSITORY}"
log "Image name: ${IMAGE_NAME}"
log "Image tag: ${TAG}"
log "Image URI: ${IMAGE_URI}"
log "Job name: ${JOB_NAME}"
log "Runtime service account: ${RUNTIME_SERVICE_ACCOUNT}"
log "Accounts CSV local path: ${ACCOUNTS_CSV}"
log "Accounts GCS URI: ${ACCOUNTS_URI}"
log "Reports GCS URI: ${REPORTS_URI}"
log "Tasks: ${TASKS}"
log "Parallelism: ${PARALLELISM}"
log "Task timeout: ${TASK_TIMEOUT}"
log "CPU: ${CPU}"
log "Memory: ${MEMORY}"
log "Playwright workers: ${ADOBE_PLAYWRIGHT_WORKERS}"
log "Script account limit: ${ADOBE_SCRIPT_ACCOUNT_LIMIT}"
log "Stop after login: ${ADOBE_STOP_AFTER_LOGIN}"
log "Stop after Lets Go: ${ADOBE_STOP_AFTER_LETS_GO}"
log "Lets Go appear timeout (ms): ${ADOBE_LETS_GO_APPEAR_TIMEOUT_MS}"
log "Strict Lets Go: ${ADOBE_STRICT_LETS_GO}"
log "Video mode: ${ADOBE_VIDEO_MODE}"
log "Debug artifacts: ${ADOBE_DEBUG_ARTIFACTS}"
log "Save artifacts to GCS: ${SAVE_ARTIFACTS}"
log "Cost estimate:"
echo "${run_cost_summary}"
log "============================================================"

log "Enabling required Google Cloud APIs..."
CURRENT_STAGE="enable-apis"
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  run.googleapis.com \
  iam.googleapis.com \
  --project="${PROJECT_ID}"

log "Ensuring runtime service account exists..."
CURRENT_STAGE="ensure-service-account"
if ! gcloud iam service-accounts describe "${RUNTIME_SERVICE_ACCOUNT}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  log "Creating service account: ${RUNTIME_SERVICE_ACCOUNT}"
  gcloud iam service-accounts create playwright-runner \
    --project="${PROJECT_ID}" \
    --display-name="Playwright Cloud Run Job Runner" || \
  gcloud iam service-accounts describe "${RUNTIME_SERVICE_ACCOUNT}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1
else
  log "Runtime service account already exists."
fi

log "Ensuring Artifact Registry repository ${REPOSITORY} exists..."
CURRENT_STAGE="ensure-artifact-registry"
if ! gcloud artifacts repositories describe "${REPOSITORY}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  log "Creating Artifact Registry repository: ${REPOSITORY}"
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Docker images for Playwright jobs" \
    --project="${PROJECT_ID}" || \
  gcloud artifacts repositories describe "${REPOSITORY}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1
else
  log "Artifact Registry repository already exists."
fi

log "Ensuring Cloud Storage bucket gs://${ACCOUNTS_BUCKET} exists..."
CURRENT_STAGE="ensure-bucket"
if ! gcloud storage buckets describe "gs://${ACCOUNTS_BUCKET}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  log "Creating bucket: gs://${ACCOUNTS_BUCKET}"
  gcloud storage buckets create "gs://${ACCOUNTS_BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --project="${PROJECT_ID}" || \
  gcloud storage buckets describe "gs://${ACCOUNTS_BUCKET}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1
else
  log "Bucket already exists."
fi

log "Uploading ${ACCOUNTS_CSV} to ${ACCOUNTS_URI}..."
CURRENT_STAGE="upload-accounts"
gcloud storage cp "${ACCOUNTS_CSV}" "${ACCOUNTS_URI}" \
  --project="${PROJECT_ID}"

retry_iam_binding() {
  local cmd=("$@")
  local max_attempts=5
  for attempt in $(seq 1 "$max_attempts"); do
    if "${cmd[@]}" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$attempt" -lt "$max_attempts" ]]; then
      log "IAM binding attempt $attempt failed (etag conflict likely), retrying in 5s..."
      sleep 5
    fi
  done
  log "IAM binding failed after $max_attempts attempts."
  return 1
}

if [[ "${SKIP_IAM_BINDINGS:-0}" == "1" ]]; then
  log "Skipping bucket IAM bindings because SKIP_IAM_BINDINGS=1"
else
  log "Granting runtime service account bucket read access..."
  CURRENT_STAGE="grant-bucket-read"
  retry_iam_binding gcloud storage buckets add-iam-policy-binding "gs://${ACCOUNTS_BUCKET}" \
    --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
    --role="roles/storage.objectViewer" \
    --project="${PROJECT_ID}"

  log "Granting runtime service account report write access..."
  CURRENT_STAGE="grant-bucket-write"
  retry_iam_binding gcloud storage buckets add-iam-policy-binding "gs://${REPORTS_BUCKET}" \
    --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
    --role="roles/storage.objectCreator" \
    --project="${PROJECT_ID}"
fi

log "Granting runtime service account logging permission..."
CURRENT_STAGE="grant-logging"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/logging.logWriter" \
  --condition=None >/dev/null || true

log "Granting Cloud Run service agent permission to use runtime service account..."
CURRENT_STAGE="grant-run-as"
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SERVICE_ACCOUNT}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser" >/dev/null || true

log "Building and pushing Docker image: ${IMAGE_URI}"
CURRENT_STAGE="build-image"
gcloud builds submit \
  --tag="${IMAGE_URI}" \
  --project="${PROJECT_ID}" \
  .

log "Deploying Cloud Run Job: ${JOB_NAME}"
CURRENT_STAGE="deploy-job"
gcloud run jobs deploy "${JOB_NAME}" \
  --image="${IMAGE_URI}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --service-account="${RUNTIME_SERVICE_ACCOUNT}" \
  --tasks="${TASKS}" \
  --parallelism="${PARALLELISM}" \
  --max-retries=1 \
  --task-timeout="${TASK_TIMEOUT}" \
  --cpu="${CPU}" \
  --memory="${MEMORY}" \
  --set-env-vars="CI=1,ADOBE_ACCOUNTS_CSV=/tmp/accounts.csv,ADOBE_ACCOUNTS_GCS_URI=${ACCOUNTS_URI},ADOBE_REPORTS_GCS_URI=${REPORTS_URI},ADOBE_PLAYWRIGHT_WORKERS=${ADOBE_PLAYWRIGHT_WORKERS},ADOBE_STOP_AFTER_LOGIN=${ADOBE_STOP_AFTER_LOGIN},ADOBE_STOP_AFTER_LETS_GO=${ADOBE_STOP_AFTER_LETS_GO},ADOBE_SCRIPT_ACCOUNT_LIMIT=${ADOBE_SCRIPT_ACCOUNT_LIMIT},ADOBE_LETS_GO_APPEAR_TIMEOUT_MS=${ADOBE_LETS_GO_APPEAR_TIMEOUT_MS},ADOBE_STRICT_LETS_GO=${ADOBE_STRICT_LETS_GO},ADOBE_VIDEO_MODE=${ADOBE_VIDEO_MODE},ADOBE_DEBUG_ARTIFACTS=${ADOBE_DEBUG_ARTIFACTS},SAVE_ARTIFACTS=${SAVE_ARTIFACTS}"

notify_chat "Starting Cloud Run job ${JOB_NAME}. Region=${REGION}, tasks=${TASKS}, parallelism=${PARALLELISM}, cpu=${CPU}, memory=${MEMORY}, workers=${ADOBE_PLAYWRIGHT_WORKERS}, account_limit=${ADOBE_SCRIPT_ACCOUNT_LIMIT}, reports=${REPORTS_URI}." || true

log "Executing Cloud Run Job: ${JOB_NAME}"
log "Watch logs for:"
log "  [SERVER] Starting Adobe Playwright Cloud Run job"
log "  [SERVER] Fetching accounts from GCS"
log "  [SERVER] Running only tests/adobe/script.spec.ts"
log "  Login flow completed successfully"

CURRENT_STAGE="execute-job"
gcloud run jobs execute "${JOB_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --wait

notify_chat "Completed Cloud Run job ${JOB_NAME}. Region=${REGION}, tasks=${TASKS}, parallelism=${PARALLELISM}, cpu=${CPU}, memory=${MEMORY}, reports=${REPORTS_URI}." || true

log "Cloud Run job completed."
log "Final cost estimate:"
echo "${run_cost_summary}"

log "To view logs, run:"
echo "gcloud logging read 'resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${JOB_NAME}\"' --project=${PROJECT_ID} --limit=100 --format='value(timestamp,textPayload)'"

log "Reports path:"
echo "${REPORTS_URI}"
