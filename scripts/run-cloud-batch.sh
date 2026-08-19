#!/bin/bash
set -euo pipefail

# ── Cloud Run Job auto-injects these ──────────────────────
TASK_INDEX="${CLOUD_RUN_TASK_INDEX:-0}"
TASK_COUNT="${CLOUD_RUN_TASK_COUNT:-1}"
# ─────────────────────────────────────────────────────────

echo "=== Cloud Run Task ${TASK_INDEX} of ${TASK_COUNT} starting ==="
echo "Container: $(hostname)"

# Toggle: upload run output (CSV reports + Playwright artifacts) to the GCS bucket.
#   true  -> reports and artifacts are uploaded to GCS
#   false -> nothing is uploaded; rely on the Cloud Run logs only
SAVE_ARTIFACTS="${SAVE_ARTIFACTS:-false}"
echo "Save reports/artifacts to GCS: ${SAVE_ARTIFACTS}"

# Resolve accounts GCS URI — prefer ADOBE_ACCOUNTS_GCS_URI (full URI),
# fall back to legacy GCS_BUCKET (bucket name only, expects accounts.csv at root).
if [[ -n "${ADOBE_ACCOUNTS_GCS_URI:-}" ]]; then
  ACCOUNTS_GCS_URI="${ADOBE_ACCOUNTS_GCS_URI}"
  # Extract bucket name for result uploads: gs://bucket/path -> bucket
  _bucket="${ACCOUNTS_GCS_URI#gs://}"
  GCS_BUCKET="${_bucket%%/*}"
elif [[ -n "${GCS_BUCKET:-}" ]]; then
  ACCOUNTS_GCS_URI="gs://${GCS_BUCKET}/accounts.csv"
else
  echo "ERROR: Set ADOBE_ACCOUNTS_GCS_URI (full GCS URI) or GCS_BUCKET (bucket name)."
  exit 1
fi

# Resolve reports GCS URI — prefer ADOBE_REPORTS_GCS_URI, fall back to bucket root.
REPORTS_GCS_URI="${ADOBE_REPORTS_GCS_URI:-gs://${GCS_BUCKET}/results}"

ACCOUNTS_FULL="/tmp/accounts_full.csv"
ACCOUNTS_SLICE="/tmp/accounts_task_${TASK_INDEX}.csv"

echo "[1/4] Downloading accounts from ${ACCOUNTS_GCS_URI} ..."
gcloud storage cp "${ACCOUNTS_GCS_URI}" "$ACCOUNTS_FULL"

echo "[2/4] Slicing accounts for task ${TASK_INDEX} ..."
node /app/scripts/slice-accounts.mjs \
  "$ACCOUNTS_FULL" \
  "$TASK_INDEX" \
  "$TASK_COUNT" \
  "$ACCOUNTS_SLICE"

ACCOUNT_COUNT=$(tail -n +2 "$ACCOUNTS_SLICE" | grep -c . || true)
echo "Task ${TASK_INDEX}: ${ACCOUNT_COUNT} accounts to process"

if [ "$ACCOUNT_COUNT" -eq 0 ]; then
  echo "No accounts assigned to this task — exiting cleanly."
  exit 0
fi

export ADOBE_ACCOUNTS_CSV="$ACCOUNTS_SLICE"
export ADOBE_RUN_ID="${ADOBE_RUN_ID:-task-${TASK_INDEX}}"

echo "[3/4] Running Playwright (config: playwright.cloud.config.ts) ..."
npx playwright test \
  --config=playwright.cloud.config.ts \
  --project=adobe-chromium \
  2>&1 | tee "/tmp/playwright-task-${TASK_INDEX}.log" || true

if [ "$SAVE_ARTIFACTS" = "true" ]; then
  echo "[4/4] Uploading reports and artifacts to ${REPORTS_GCS_URI}/task-${TASK_INDEX}/ ..."

  REPORTS_DIR="/app/reports"
  if [ -d "$REPORTS_DIR" ]; then
    gcloud storage cp -r "$REPORTS_DIR/" \
      "${REPORTS_GCS_URI}/task-${TASK_INDEX}/reports/"
    echo "Uploaded reports dir."
  fi

  PLAYWRIGHT_REPORT_DIR="/app/playwright-report"
  if [ -d "$PLAYWRIGHT_REPORT_DIR" ]; then
    gcloud storage cp -r "$PLAYWRIGHT_REPORT_DIR/" \
      "${REPORTS_GCS_URI}/task-${TASK_INDEX}/playwright-report/"
    echo "Uploaded playwright-report dir."
  fi

  # Downloaded design PNGs (the whole point of the download flow). Cloud Run's disk is
  # ephemeral, so these are lost when the task ends unless copied to GCS here.
  DOWNLOADS_DIR="/app/downloads"
  if [ -d "$DOWNLOADS_DIR" ]; then
    gcloud storage cp -r "$DOWNLOADS_DIR/" \
      "${REPORTS_GCS_URI}/task-${TASK_INDEX}/downloads/"
    echo "Uploaded downloads dir ($(find "$DOWNLOADS_DIR" -type f | wc -l) files)."
  fi
else
  echo "[4/4] SAVE_ARTIFACTS=false — skipping all GCS uploads (reports + artifacts)."
  echo "      Run output is available in the Cloud Run logs only."
fi

echo "=== Task ${TASK_INDEX} complete ==="
