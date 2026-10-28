#!/usr/bin/env bash
# Run once before launching batches.
# Does all one-time setup: APIs, service account, Artifact Registry,
# GCS bucket, IAM bindings, and Docker image build.
#
# Usage:
#   bash scripts/setup-run.sh
#
# After success it prints the IMAGE_URI to use with run-batches.sh.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-project-8606ec18-5b16-4826-af3}"
REGION="${REGION:-asia-south1}"
REPOSITORY="${REPOSITORY:-playwright-jobs}"
IMAGE_NAME="${IMAGE_NAME:-adobe-login-flow}"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-playwright-runner@${PROJECT_ID}.iam.gserviceaccount.com}"
ACCOUNTS_BUCKET="${ACCOUNTS_BUCKET:-${PROJECT_ID}-adobe-accounts}"
REPORTS_BUCKET="${REPORTS_BUCKET:-${ACCOUNTS_BUCKET}}"
TAG="${TAG:-$(date +%Y%m%d%H%M%S)}"

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"

log() { echo "[SETUP][$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

log "============================================================"
log "Adobe Playwright Cloud Run — One-Time Setup"
log "Project:    ${PROJECT_ID}"
log "Region:     ${REGION}"
log "Image URI:  ${IMAGE_URI}"
log "SA:         ${RUNTIME_SERVICE_ACCOUNT}"
log "Bucket:     gs://${ACCOUNTS_BUCKET}"
log "============================================================"

# ── APIs ────────────────────────────────────────────────────────────────────
log "Enabling required APIs..."
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  run.googleapis.com \
  iam.googleapis.com \
  --project="${PROJECT_ID}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"

# ── Service account ──────────────────────────────────────────────────────────
log "Ensuring runtime service account exists..."
if ! gcloud iam service-accounts describe "${RUNTIME_SERVICE_ACCOUNT}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create playwright-runner \
    --project="${PROJECT_ID}" \
    --display-name="Playwright Cloud Run Job Runner" || \
  gcloud iam service-accounts describe "${RUNTIME_SERVICE_ACCOUNT}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1
  log "Service account created."
else
  log "Service account already exists."
fi

# ── Artifact Registry ────────────────────────────────────────────────────────
log "Ensuring Artifact Registry repository exists..."
if ! gcloud artifacts repositories describe "${REPOSITORY}" \
    --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Docker images for Playwright jobs" \
    --project="${PROJECT_ID}" || \
  gcloud artifacts repositories describe "${REPOSITORY}" \
    --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1
  log "Artifact Registry repository created."
else
  log "Artifact Registry repository already exists."
fi

# ── GCS bucket ───────────────────────────────────────────────────────────────
log "Ensuring GCS bucket exists..."
if ! gcloud storage buckets describe "gs://${ACCOUNTS_BUCKET}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${ACCOUNTS_BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --project="${PROJECT_ID}" || \
  gcloud storage buckets describe "gs://${ACCOUNTS_BUCKET}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1
  log "Bucket created."
else
  log "Bucket already exists."
fi

# ── IAM bindings (sequential — no etag conflicts) ────────────────────────────
retry_iam() {
  local max=5
  for attempt in $(seq 1 "$max"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    [[ "$attempt" -lt "$max" ]] && { log "IAM retry $attempt/5 in 5s..."; sleep 5; }
  done
  log "ERROR: IAM binding failed after $max attempts."
  return 1
}

log "Granting SA bucket read access..."
retry_iam gcloud storage buckets add-iam-policy-binding "gs://${ACCOUNTS_BUCKET}" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectViewer" \
  --project="${PROJECT_ID}"

log "Granting SA bucket write access (reports, and PNGs when DOWNLOADS_GCS_URI is set)..."
retry_iam gcloud storage buckets add-iam-policy-binding "gs://${REPORTS_BUCKET}" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectCreator" \
  --project="${PROJECT_ID}"

# The PNG upload uses `gcloud storage cp --no-clobber`, which reads the destination to
# skip an account whose PNG already exists. Same bucket as above by default (then this
# is a no-op); needed when REPORTS_BUCKET is a separate bucket.
log "Granting SA read access on the reports bucket (no-clobber check)..."
retry_iam gcloud storage buckets add-iam-policy-binding "gs://${REPORTS_BUCKET}" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectViewer" \
  --project="${PROJECT_ID}"

log "Granting SA logging permission..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/logging.logWriter" \
  --condition=None >/dev/null || true

log "Granting Cloud Run service agent permission to use SA..."
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SERVICE_ACCOUNT}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser" >/dev/null || true

# ── Cloud Build service account permissions ──────────────────────────────────
# Projects created recently no longer get the legacy
# ${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com account, and Cloud Build falls
# back to the Compute Engine default SA — which in a new project has NO roles,
# because Google stopped auto-granting it Editor. The build then dies confusingly
# on its OWN staging bucket:
#
#   INVALID_ARGUMENT: could not resolve source: Error 403:
#   <n>-compute@developer.gserviceaccount.com does not have storage.objects.get
#   access to .../<project>_cloudbuild/objects/source/....tgz
#
# Grant the three roles the build actually needs: read the uploaded source and
# write artifacts, push the image, and emit build logs. Prefer the legacy SA when
# it exists so older projects keep their existing setup.
if gcloud iam service-accounts describe \
     "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
     --project="${PROJECT_ID}" >/dev/null 2>&1; then
  BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
else
  BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
log "Granting Cloud Build permissions to ${BUILD_SA}..."
for role in roles/storage.objectAdmin roles/artifactregistry.writer roles/logging.logWriter; do
  retry_iam gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${BUILD_SA}" \
    --role="${role}" \
    --condition=None || log "  WARN: could not grant ${role} (may already be present)"
done

# IAM propagation can lag the build submit by a few seconds; a fresh grant that
# has not landed yet produces exactly the 403 above.
log "Waiting 15s for IAM propagation before building..."
sleep 15

# ── Docker image build ────────────────────────────────────────────────────────
log "Building Docker image: ${IMAGE_URI}"
gcloud builds submit \
  --tag="${IMAGE_URI}" \
  --project="${PROJECT_ID}" \
  .

log "============================================================"
log "Setup complete."
log ""
log "IMAGE_URI=${IMAGE_URI}"
log ""
log "Next step — run batches:"
log "  IMAGE_URI=${IMAGE_URI} bash scripts/run-batches.sh"
log "============================================================"

export IMAGE_URI
export TAG
