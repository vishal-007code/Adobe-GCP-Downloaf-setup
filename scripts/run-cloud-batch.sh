#!/bin/bash
set -euo pipefail

# ── Cloud Run Job auto-injects these ──────────────────────
TASK_INDEX="${CLOUD_RUN_TASK_INDEX:-0}"
TASK_COUNT="${CLOUD_RUN_TASK_COUNT:-1}"
# ─────────────────────────────────────────────────────────

# /app in the container. Resolved from this script's location so scripts/run-local-job.sh
# can run the very same task script on a laptop.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

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

# Google Chat updates straight from the tasks (scripts/run-notify.mjs): task 0 posts
# "started", every task records its tally, and the tasks between them post progress at
# each 10%, one alert per kind of problem, and the final summary. No-op without
# GOOGLE_CHAT_WEBHOOK_URL. ADOBE_STATUS_URI holds the small objects they coordinate through.
export ADOBE_STATUS_URI="${ADOBE_STATUS_URI:-${REPORTS_GCS_URI}/status/${CLOUD_RUN_EXECUTION:-local}}"
notify() { node "$APP_DIR/scripts/run-notify.mjs" "$@" || true; }
# A task that dies before Playwright runs still reports, and still counts as finished.
trap 'notify setup-failed "line ${LINENO}: ${BASH_COMMAND}"' ERR

# PNGs are NOT kept by default: each account's download is recorded as downloaded=yes in
# its [ADOBE_RESULT] log line, and scripts/build-run-report.sh builds the report from
# those lines. To also copy every PNG to the bucket as <prefix>/<email>.png (uploaded by
# the test itself, src/adobe/download-upload.ts), set ADOBE_DOWNLOADS_GCS_URI=gs://...
ADOBE_DOWNLOADS_GCS_URI="${ADOBE_DOWNLOADS_GCS_URI:-off}"
if [[ "${ADOBE_DOWNLOADS_GCS_URI}" == "off" ]]; then
  ADOBE_DOWNLOADS_GCS_URI=""
fi
export ADOBE_DOWNLOADS_GCS_URI
echo "Per-account PNG uploads: ${ADOBE_DOWNLOADS_GCS_URI:-off}"

ACCOUNTS_FULL="/tmp/accounts_full.csv"
ACCOUNTS_SLICE="/tmp/accounts_task_${TASK_INDEX}.csv"

echo "[1/4] Downloading accounts from ${ACCOUNTS_GCS_URI} ..."
if [[ "${ACCOUNTS_GCS_URI}" == gs://* ]]; then
  gcloud storage cp "${ACCOUNTS_GCS_URI}" "$ACCOUNTS_FULL"
else
  cp "${ACCOUNTS_GCS_URI}" "$ACCOUNTS_FULL"   # local file (run-local-job.sh)
fi

echo "[2/4] Slicing accounts for task ${TASK_INDEX} ..."
node "$APP_DIR/scripts/slice-accounts.mjs" \
  "$ACCOUNTS_FULL" \
  "$TASK_INDEX" \
  "$TASK_COUNT" \
  "$ACCOUNTS_SLICE"

ACCOUNT_COUNT=$(tail -n +2 "$ACCOUNTS_SLICE" | grep -c . || true)
echo "Task ${TASK_INDEX}: ${ACCOUNT_COUNT} accounts to process"

notify start "$ACCOUNTS_FULL"   # posts only from task 0

if [ "$ACCOUNT_COUNT" -eq 0 ]; then
  echo "No accounts assigned to this task — exiting cleanly."
  notify task-end /dev/null 0 0
  exit 0
fi

export ADOBE_ACCOUNTS_CSV="$ACCOUNTS_SLICE"
export ADOBE_RUN_ID="${ADOBE_RUN_ID:-task-${TASK_INDEX}}"

echo "[3/4] Running Playwright (config: playwright.cloud.config.ts) ..."
trap - ERR   # from here on a failure is reported by task-end, not as a setup failure
PLAYWRIGHT_LOG="/tmp/playwright-task-${TASK_INDEX}.log"
set +e
npx playwright test \
  --config=playwright.cloud.config.ts \
  --project=adobe-chromium \
  2>&1 | tee "$PLAYWRIGHT_LOG"
PLAYWRIGHT_EXIT=${PIPESTATUS[0]}
set -e

# Records this task's tally, then posts any alert / progress milestone / final summary due.
notify task-end "$PLAYWRIGHT_LOG" "$PLAYWRIGHT_EXIT" "$ACCOUNT_COUNT"

if [ "$SAVE_ARTIFACTS" = "true" ]; then
  echo "[4/4] Uploading reports and artifacts to ${REPORTS_GCS_URI}/task-${TASK_INDEX}/ ..."

  REPORTS_DIR="$APP_DIR/reports"
  if [ -d "$REPORTS_DIR" ]; then
    gcloud storage cp -r "$REPORTS_DIR/" \
      "${REPORTS_GCS_URI}/task-${TASK_INDEX}/reports/"
    echo "Uploaded reports dir."
  fi

  PLAYWRIGHT_REPORT_DIR="$APP_DIR/playwright-report"
  if [ -d "$PLAYWRIGHT_REPORT_DIR" ]; then
    gcloud storage cp -r "$PLAYWRIGHT_REPORT_DIR/" \
      "${REPORTS_GCS_URI}/task-${TASK_INDEX}/playwright-report/"
    echo "Uploaded playwright-report dir."
  fi
  # ./downloads is deliberately not copied: the PNGs are not needed, only the record
  # that each download happened (the [ADOBE_RESULT] lines and the results CSV above).
else
  echo "[4/4] SAVE_ARTIFACTS=false — skipping all GCS uploads (reports + artifacts)."
  echo "      Run output is available in the Cloud Run logs only."
fi

echo "=== Task ${TASK_INDEX} complete ==="
